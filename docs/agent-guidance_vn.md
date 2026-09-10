# Hướng dẫn cho agent

Dán phần này vào `CLAUDE.md` của dự án để đặt ký ức trước mặt agent ở **mọi
phiên**, không phải chỉ khi nó chợt nhớ ra là có tool.

Plugin **không** tự ghi file đó giúp bạn. Sửa `CLAUDE.md` của một dự án sau lưng
người ta đúng là kiểu việc mà một tầng ký ức không nên làm.

> Bản tiếng Anh: [agent-guidance.md](agent-guidance.md)

```markdown
## Always Do

- **MUST run memory_why before changing code you did not write.** Code trông có
  vẻ tuỳ tiện chính là tín hiệu mạnh nhất rằng từng có một lý do, và lý do đó đã
  thất lạc.
- **MUST check memory_conflicts before recording a new decision.** Hai quyết định
  còn hiệu lực cùng phủ một vùng, không cái nào biết cái kia, chính là kiểu hỏng
  mà tầng này sinh ra để bắt.
- **MUST run memory_changes before committing.** Đây là lúc ký ức đáng giá nhất:
  ngay trước khi một thay đổi hạ cánh và mâu thuẫn với thứ ai đó đã quyết và đã
  ghi lại.
- **MUST cite the source_ref** của bất cứ thứ gì ký ức trả về khi hành động dựa
  trên nó.
- **MUST record the alternative** khi ghi một quyết định. "Chốt ở hai lần" là một
  thiết lập; "chốt ở hai lần, chọn thay vì backoff vì cổng thanh toán đếm số lần
  thử" là một quyết định — và chỉ cái thứ hai mới đánh giá lại được sau này.

## Never Do

- **NEVER treat a memory result as current state.** Nó mô tả điều đã đúng **vào
  lúc được ghi**. Kiểm lại với cây mã nguồn.
- **NEVER resolve a CONTRADICTS pair on your own.** Đưa nó ra; người quyết.
- **NEVER delete a memory to make a contradiction go away.** `memory prune` chỉ
  xoá ghi chép episodic cũ mà không ai trỏ tới; một quyết định bạn không đồng ý
  thì dùng `SUPERSEDES` kèm lý do.
- **NEVER record a decision without a source_ref.** Ký ức không truy ngược được
  là ký ức không kiểm chứng được, mà người ta vẫn sẽ tin nó.
- **NEVER record secrets, credentials, or anything unverified.** Một tầng ký ức
  đầy phỏng đoán còn tệ hơn một tầng rỗng, vì nó **được tin**.
```

## Vì sao đây là lớp yếu nhất trong bốn lớp

Hướng dẫn trong `CLAUDE.md` phụ thuộc vào việc agent đọc và làm theo. Những cơ
chế mạnh hơn là những cơ chế **không** phụ thuộc vào đó:

| Lớp | Cơ chế | Có phụ thuộc vào việc agent nhớ không? |
|---|---|---|
| 1 | Hướng dẫn `CLAUDE.md` | Có |
| 2 | Skill, mô tả bằng chính lời người dùng | Một phần — harness tự định tuyến |
| 3 | Hook `SessionStart` bơm ràng buộc đang hiệu lực | Không |
| 4 | Hook `PreToolUse` trên `Read`/`Grep`/`Glob` | Không |

Lớp 4 mạnh nhất và hoạt động khác hẳn phần còn lại. Nó **không** bảo agent hãy
tra ký ức. Nó nổ đúng lúc agent với tay lấy công cụ tìm kiếm thô — đúng lúc câu
hỏi đang thực sự được đặt ra — rồi đặt thứ ký ức đang giữ ngay trước mặt nó.

## Giữ cho nó không nói dối

Mỗi lớp trong số này đều là một kẻ nói dối tự tin nếu kho lạc hậu, nên
`memory_search` và `memory_why` gắn kèm khối `index.stale` khi kho được dựng ở
một commit cũ hơn, và từng kết quả cũ hơn ngưỡng đều bị đánh dấu.

Hướng dẫn bảo agent hãy tin ký ức, mà ký ức không tự nói khi nào **đừng** tin,
thì còn tệ hơn không có hướng dẫn nào.
