# Kết quả đo M0

Đo trên Linux x64, Node v22.22.2, `@ladybugdb/core@0.20.3`, trong container mà
repo này được dựng. Mọi con số bên dưới đến từ **chạy code**, không từ tài liệu
kỹ thuật. Chỗ nào không trả lời được ở đây thì ghi rõ là không trả lời được, chứ
không ước lượng.

> Bản tiếng Anh: [m0-findings.md](m0-findings.md)

---

## 1. Nền lưu trữ: LadybugDB thật sự cho những gì

```
LOAD fts     -> Binder exception: Extension: fts is an official extension and has not been installed.
LOAD vector  -> Binder exception: Extension: vector is an official extension and has not been installed.
LOAD json    -> Binder exception: Extension: json is an official extension and has not been installed.
```

**Không extension chính thức nào nạp được** trên nền này, và trong môi trường
sandbox cũng không có đường mạng để cài. Vậy:

- **Tìm kiếm từ khoá phải tự làm.** Không có FTS để dựa vào.
- **Không có chỉ mục vector.** Tìm kiếm ngữ nghĩa là quét thẳng.

Có một thứ tốt hơn dự kiến. `array_cosine_similarity` là **hàm dựng sẵn, không
thuộc extension vector**, và nó trả kết quả đúng:

```
CREATE NODE TABLE T(id STRING, v FLOAT[4], PRIMARY KEY(id))    -> ok
array_cosine_similarity(t.v, CAST([1.0,0,0,0] AS FLOAT[4]))    -> 1
```

Nên vector được lưu thành cột `FLOAT[dims]` **trong cùng kho** với node và cạnh,
và cosine tính được ngay trong database. Đồ thị, văn bản và vector nằm chung một
kho; không có kho thứ hai nên **không có bước nào giữa ghi và đọc** (C1).

**Quyết định:** LadybugDB cho đồ thị và lưu trữ. BM25 tự viết trong tiến trình.
Tìm kiếm ngữ nghĩa quét thẳng, chặn ở 10.000 vector, **lọc theo khoảng cách
trước** rồi mới cắt — để cắt theo độ liên quan chứ không theo thứ tự dòng.

---

## 2. Đồng thời: phép đo đã đổi cả thiết kế

Kế hoạch coi truy cập đồng thời là rủi ro phải quản bằng lease hoặc dò khoá. Đo
xong mới thấy có cách tốt hơn.

### Hai writer

```
tiến trình A (đọc-ghi): WROTE ok
tiến trình B (đọc-ghi): FAILED: IO exception: Could not set lock on file
```

Writer thứ hai **hỏng ngay và sạch sẽ**. Không hỏng dữ liệu, không treo. Hỏng
nhanh là kết quả xử lý được.

### Reader chặn writer

```
bên giữ (handle đọc-ghi, chỉ chạy một câu MATCH): giữ khoá 4 giây
writer C trong khoảng đó: FAILED: Could not set lock on file
```

Handle mở ở chế độ đọc-ghi **lấy khoá độc quyền kể cả khi chỉ đọc**. Đây là cái
bẫy: một server sống lâu chỉ cần chạy một câu truy vấn là chặn mọi lệnh ghi suốt
đời nó.

### Cờ chỉ-đọc

`new Database(path, bufferSize, compression, readOnly)` — tham số thứ tư.

```
bên giữ chỉ-đọc đang mở, writer D chạy:      D WROTE ok
hai bên giữ chỉ-đọc cùng lúc:                cả hai ok
```

`readOnly: true` lấy khoá **chia sẻ**. Reader sống chung với nhau và với writer.

**Quyết định:** mọi đường đọc mở chỉ-đọc; chỉ lệnh ghi mới lấy handle đọc-ghi.
Đúng một cờ đó **xoá sạch** toàn bộ bài toán dò tiến trình đa nền mà kiến trúc
tham chiếu phải giải — reader đơn giản là không bao giờ giữ cái khoá chặn writer.

### Cái giá, và chốt chặn

Handle chỉ-đọc không chỉ rẻ, nó **đóng băng**:

```
handle chỉ-đọc mở, thấy:            100 node
writer commit thêm 50
vẫn handle đó, hỏi lại:             100 node     <- không lỗi, không cảnh báo
một handle mở mới:                  150 node
```

Một reader sống lâu phục vụ **mãi mãi** cái ảnh chụp lúc nó mở, trong im lặng.
Đây là lớp lỗi mới, không có trong kế hoạch gốc, và đúng loại mà tầng này sinh ra
để chặn — nên nó có ràng buộc riêng:

> **C10 — Reader không bao giờ được phục vụ ảnh chụp cũ hơn lần ghi gần nhất.**

Cách cài: `meta.json` mang bộ đếm `writeSeq`, tăng ở mỗi lần commit. Handle
chỉ-đọc so bộ đếm trước khi phục vụ và mở lại khi nó đã dịch. Có test canh.

Cùng bộ đếm đó làm khoá cho cache tìm kiếm trong tiến trình, nên một chỉ mục đã
cache cũng không thể sống lâu hơn lần ghi làm nó vô hiệu.

### Lệnh ghi không lấy được khoá

Hook phiên ghi trong khi phiên khác có thể đang ghi. Thay vì đi dò khoá, lệnh ghi
gặp `StoreLockedError` sẽ nối vào **nhật ký theo phiên**, và `memory merge` gộp
lại sau. Người gọi **được báo** là đã xếp hàng — một ký ức đã ghi nhưng chưa tìm
kiếm được là kết quả khác với một ký ức đang sống, và khác biệt đó quan trọng với
người vừa ghi nó. `memory doctor` báo số đang tồn nên độ trễ không bao giờ vô
hình.

---

## 3. Tìm kiếm từ khoá: BM25 tự viết nhanh cỡ nào

> Đã bị mục 7 thay thế. Số bên dưới là chi phí của chỉ mục trong RAM, giữ lại vì
> chúng chính là lý do chỉ mục được chuyển vào kho.

Chỉ mục đảo, `k1=1.2`, `b=0.75`, dùng chung tokenizer cho cả đánh chỉ mục lẫn
truy vấn.

| Node | Dựng chỉ mục | Truy vấn (p50) | Heap |
|---|---|---|---|
| 10.000 | 750 ms | 20 ms | 82 MB |
| 100.000 | 8.131 ms | 412 ms | 660 MB |

Đo đầu-cuối qua CLI thật, trên kho **1.040 node**:

| Thao tác | Tiến trình nguội | Nóng (chỉ mục đã cache) |
|---|---|---|
| `search` | ~800 ms | ~100 ms |
| `why` | ~700 ms | — |
| `ingest` lại, không đổi gì | 379 ms | — |

**Nói thẳng nghĩa là gì.** Chỉ mục dựng trong RAM từ kho ở lần dùng đầu. Ổn tới
khoảng 10.000 node và thoải mái ở mức 1.000–2.000 mà một kho ký ức dự án thực tế
chứa. Ở 100.000 node thì không đủ tốt: 8 giây để dựng và 412 ms mỗi truy vấn.

Cache khoá theo `writeSeq` khiến MCP server sống lâu chỉ trả giá dựng **một
lần** thay vì mỗi truy vấn — đúng chỗ cần. Lệnh CLI ngắn hạn vẫn trả mỗi lần.

---

## 4. Nhúng: đo được gì và không đo được gì

`Snowflake/snowflake-arctic-embed-xs` ở 384 chiều được chọn làm mặc định.
**Không benchmark được ở đây**, và lý do đáng ghi lại:

```
huggingface.co:443 -> CONNECT tunnel failed, 403 (network policy denial)
```

Model hub không với tới được từ môi trường này. Ba hệ quả, cả ba đều làm thiết
kế tốt lên:

1. **Nhà cung cấp nhúng là một interface, không phải phụ thuộc cứng.** Provider
   transformers.js là `optionalDependency`.
2. **Có bản dự phòng offline**, `HashEmbeddingProvider`: đặc trưng token băm tất
   định, 384 chiều. Nó bắt được trùng lặp từ vựng và không gì sâu hơn, **và nó
   nói ra điều đó** — báo `provider: 'hash'` và `status: 'degraded'`, nên một kho
   nhúng kiểu này không bao giờ bị nhầm với kho nhúng đúng. Nó nhúng 1.000 chunk
   trong **158 ms**.
3. **Bộ test không cần mạng và không cần tải model.**

Quét thẳng cosine, 10.000 vector ở 384 chiều: **11 ms mỗi truy vấn**. Quét không
phải nút thắt; dựng chỉ mục từ khoá mới là.

> Câu hỏi để mở ở đây — 384 chiều và ngưỡng 0,5 có hợp với **văn xuôi quyết
> định** không — **đã được trả lời**, và câu trả lời không phải là ngưỡng. Xem
> mục cuối.

---

## 5. Định danh không gian vector

Ghi theo từng node dưới dạng `{model, dimensions, provider}`. Tìm kiếm chỉ so
vector cùng không gian đang hoạt động và **báo số lượng đã bỏ qua**; `doctor`
fail ồn ào khi một kho chứa nhiều hơn một không gian. Độ rộng cố định lúc `init`
và nướng vào DDL thành `FLOAT[dims]`; đổi nó nghĩa là xây lại.

Bộ phân tích số chiều chỉ nhận **chữ số thuần**. `1e3`, `0x10`, `3.5`, `+5` và
`4096x` đều bị từ chối, vì một giá trị đọc ra một độ rộng lúc DDL và một độ rộng
khác lúc chạy sẽ tạo ra một kho **bất đồng với chính embedder của nó**.

---

## 6. Một lỗi im lặng phát hiện trong lúc xây

Đáng ghi vì nó đúng là lớp bug mà cả thiết kế này nhắm tới.

Phần tích hợp tree-sitter trông như chạy tốt: grammar nạp được, không lỗi, chunk
ra kèm khoảng dòng hợp lý. Nhưng **mọi chunk đều là cửa sổ ký tự** — nhánh AST
chưa từng chạy. `require('web-tree-sitter')` trả về lớp parser **trước** `init()`
và một **object khác, không có constructor**, sau đó — nên chỗ gọi thứ hai nạp
được grammar mà không bao giờ dựng nổi parser. `try/catch` lui về cắt ký tự rồi
che sạch chuyện đó.

Không có gì thất bại. Chất lượng chunk chỉ đơn giản là kém hơn thiết kế, **vĩnh
viễn, không triệu chứng**. Nó bị bắt bởi một test khẳng định AST thực sự chạy —
không phải bởi thứ gì đang canh lỗi.

Sửa bằng cách require module đúng một lần sau một accessor có cache. Bài học
chính là bài học đứng sau C4: **một bản dự phòng không tự khai báo thì không phân
biệt được với một tính năng đang chạy.**

---

## Cổng

| Câu hỏi | Trả lời |
|---|---|
| LadybugDB làm được BM25 không? | Không. Tự viết trong tiến trình. 20 ms/truy vấn ở 10k, 412 ms ở 100k. |
| Có chỉ mục vector không? | Không. Quét thẳng, 11 ms ở 10k × 384. |
| Nhúng tốn bao lâu? | Bản dự phòng: 158 ms / 1.000 chunk. Model thật: **chưa đo**, hub không với tới. |
| Hai writer thì sao? | Cái thứ hai hỏng nhanh. Reader dùng khoá chia sẻ và không bao giờ chặn writer. Phát hiện và chặn được nguy cơ ảnh chụp đóng băng (C10). |

---

## 7. Chỉ mục từ khoá chuyển vào kho (R4)

Chỉ mục trong RAM phải đọc và tách từ **mọi node** trước khi trả lời bất cứ gì.
MCP server sống lâu trả giá đó một lần; mỗi lệnh CLI trả lại. Ở 100.000 node đó
là 8 giây dựng trước kết quả đầu tiên.

Giờ postings nằm trong kho, **một dòng cho mỗi term** thay vì một dòng cho mỗi
cặp (term, tài liệu), kèm độ dài tài liệu ngay trong entry nên chấm điểm không
cần tra lần hai. Một truy vấn chỉ đọc các dòng của chính term nó.

### Đo ở 20.000 node

| | Trước | Sau |
|---|---|---|
| Dựng chỉ mục lúc khởi động | ~8 s ở 100k / ~750 ms ở 10k | không có |
| Truy vấn, tiến trình nóng | 100 ms (sau 493 ms dựng) | **50 ms** |
| Truy vấn, CLI nguội | ~800 ms ở 1k | **414 ms** ở 20k |

Con số CLI nguội phần lớn **không phải** do tìm kiếm: sàn khởi động tiến trình là
**231 ms** trước khi đọc bất cứ gì, so với `node -e ""` trần là 29 ms.

### Hai sai lầm phát hiện nhờ đo, không nhờ suy luận

**Tập ứng viên không phải danh sách rút gọn.** Bản đầu lấy một dòng tóm tắt cho
**mọi** tài liệu chứa bất kỳ term nào của truy vấn. Trên một corpus ít từ riêng
biệt thì đó là cả kho, chia thành hàng trăm lượt quét `list_contains`: **8 giây
mỗi truy vấn ở 20.000 node**, tệ hơn chính chỉ mục RAM mà nó thay thế. Giờ xếp
hạng diễn ra **chỉ trên posting list**, và chỉ danh sách rút gọn mới được đọc.

**Một corpus tổng hợp có thể đang đo một bệnh lý thay vì đo hệ thống.** Con số 8
giây đến từ bộ sinh dữ liệu có vốn từ **34 từ**, khiến mọi tài liệu nằm trong mọi
posting list. Văn xuôi thật có hàng nghìn term riêng biệt. Cả hai con số đều
trung thực; chỉ con số thứ hai nói về thiết kế này.

---

## 8. Parse bằng WASM, cuối cùng cũng đo được (R5)

Cho tới khi AST chunker thật sự chạy (mục 6) thì không có gì để đo. Ngưỡng được
đặt **trước khi đo**, để câu trả lời không bị lý luận ngược: **nếu parse vượt 40%
thời gian ingest thì mở lại phương án native binding cho CLI.**

1.500 file, 12,8 MB, 17.011 chunk:

| Giai đoạn | Thời gian | Tỉ lệ |
|---|---|---|
| đọc | 53 ms | 1,6% |
| **parse (tree-sitter WASM)** | **941 ms** | **27,8%** |
| che secret | 179 ms | 5,3% |
| nhúng (bản dự phòng hash) | 2.211 ms | 65,3% |
| tổng | 3.387 ms | |

**Dưới ngưỡng, và biên còn rộng hơn vẻ ngoài.** Phép đo này dùng embedder hash —
bước nhúng nhanh nhất từng chạy ở đây. Model ONNX thật chậm hơn nhiều, nên phần
nhúng phình ra và tỉ lệ parse chỉ giảm. 27,8% là **trường hợp xấu nhất** cho
WASM, không phải trường hợp thường.

Quyết định: một hiện thực WASM cho cả CLI lẫn trình duyệt, giữ nguyên. Không
native binding, không đường parser thứ hai phải nuôi. Đóng hồ sơ.

Không chạy so sánh với native. Nó sẽ không đổi quyết định — parse phải chiếm hơn
một phần ba ingest thì mới đổi được — và nói thẳng như vậy tốt hơn một con số
trông có vẻ chỉn chu mà không giải quyết gì.

---

## Câu M0 #2, đã trả lời — và câu trả lời không phải là ngưỡng

Câu này treo suốt quá trình xây: *384 chiều và ngưỡng cosine 0,5 có đúng cho văn
xuôi quyết định không?* Nó được ghi là **không trả lời được** vì model không tải
được. **Cả hai vế đều sai.**

### Model chưa bao giờ bị chặn

Lỗi hiện ra là `File doesn't exist`, và được ghi nhận thành "mạng bị chặn". Thật
ra là **độ dài đường dẫn**. Để mặc thì transformers.js cache ngay trong thư mục
package của nó; dưới pnpm đó là

```
node_modules/.pnpm/@huggingface+transformers@4.2.0/node_modules/@huggingface/transformers/.cache/...
```

và cộng thêm tên file model thì thành **279 ký tự**, vượt giới hạn 260 của
Windows. Ghi hỏng, và loader chỉ báo được thứ duy nhất nó thấy. `node fetch` lấy
trọng số bình thường: HTTP 200, 22,9 MB.

Sửa bằng cách cache ở `<MEMORY_LAYER_HOME>/models` — ngắn, ổn định, và **nằm
ngoài thư mục package**, nên cài lại không xoá mất bản đã tải.

Đằng sau nó lộ ra lỗi thứ hai: `device: 'auto'` chọn DirectML và bị từ chối với
`DML EP can only be used with CPU EPs`. Một thiết bị không chạy được là lý do để
dùng thiết bị khác, không phải lý do để mất tìm kiếm ngữ nghĩa — nên provider tụt
về CPU **và báo là đã tụt**.

### Model là model sai cho corpus này

Chạy được rồi mới thấy. Một quyết định tiếng Việt và năm câu hỏi:

| Câu hỏi | Liên quan? | `arctic-embed-xs` |
|---|---|---|
| vì sao không thử lại nhiều hơn | có | 0,749 |
| khách bị trừ tiền hai lần | có | 0,763 |
| công thức nấu phở bò | **không** | **0,764** |
| hôm nay trời đẹp quá | **không** | **0,818** |
| the weather is nice today | không | 0,518 |

"Hôm nay trời đẹp quá" chấm **cao hơn cả hai câu thật sự liên quan** khi so với
một quyết định về retry thanh toán, còn câu **tiếng Anh** không liên quan lại
thấp nhất. Model đang xếp theo *ngôn ngữ nào*, không theo chủ đề —
`snowflake-arctic-embed-xs` là model chỉ-tiếng-Anh, nên tiếng Việt co cụm vào một
vùng hẹp của không gian.

**Không ngưỡng nào sửa được chuyện đó.** 0,749 và 0,763 không tách khỏi 0,764 và
0,818; phân phối chồng lấn và cái sai nằm trên. Câu hỏi để mở chưa bao giờ là con
số cắt.

### Cái thay thế nó

| Model | Liên quan thấp nhất | Không liên quan cao nhất | Biên |
|---|---|---|---|
| `snowflake-arctic-embed-xs` | 0,749 | 0,818 | **đảo ngược** |
| `multilingual-e5-small` | 0,847 | 0,799 | 0,048 |
| `paraphrase-multilingual-MiniLM-L12-v2` | 0,319 | 0,134 | **0,185** |

`paraphrase-multilingual-MiniLM-L12-v2` tách với biên rộng gần **bốn lần**, và
giữ nguyên **384 chiều** — nên bảng vector không đổi và không có migration nào.
Ngưỡng khoảng cách chuyển 0,5 → 0,75 để nằm trong khe đo được.

`doctor` tự bắt được việc đổi model trên kho đang có:

```
model drift  WARN  stored vectors are Snowflake/snowflake-arctic-embed-xs@384/local,
                   active provider is Xenova/paraphrase-multilingual-MiniLM-L12-v2@384/local
```

### Vẫn chưa xong

Ngưỡng đổi lên 0,75 rồi **không có tác dụng**, vì hằng số còn được chép thành
literal ở `search.ts`. Một giá trị cấu hình bị một bản sao thứ hai âm thầm ghi đè
— đúng lớp lỗi dự án này liên tục tìm thấy, lần này ở **chính code của mình**.

Sau khi sửa, ba câu không liên quan đều bị loại, còn một trong hai câu liên quan
rơi sát ngoài ngưỡng — BM25 vẫn tìm ra nó. Lỗi nghiêm trọng, tức văn bản không
liên quan chấm cao hơn văn bản liên quan, đã hết.

Con số cắt hiện tinh chỉnh trên **năm câu hỏi và hai tài liệu** — đủ để loại một
model hỏng, **không đủ để gọi là đã hiệu chỉnh**. Nó cần một corpus thật và một
bộ câu hỏi viết sẵn trước khi ai đó nên tin vào con số này.
