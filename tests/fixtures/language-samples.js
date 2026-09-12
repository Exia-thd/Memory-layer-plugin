// One sample per language, with the qualified names its declarations must
// produce -- exactly those, no more. Each sample includes a trap the name
// resolver has fallen into before: a return type before a method name, a local
// variable inside a function body, a destructuring pattern, an overload.
//
// Shape: label -> [file name, source, expected qualified names].
export const SAMPLES = {
  typescript: ['a.ts', `import x from 'y';
export class OrderService {
  get(id: string): Order { return db.find(id); }
  private charge(): void {}
}
export interface Order { id: string }
export type Id = string;
export enum Status { Open, Closed }
export function top(): number { const local = 1; return local; }
export const handler = async () => { const inner = 2; };
const { a, b } = obj;
namespace Legacy { export function old() {} }
abstract class Base { abstract run(): void; }`,
    ['OrderService', 'OrderService.get', 'OrderService.charge', 'Order', 'Id', 'Status', 'top', 'handler', 'Legacy', 'Legacy.old', 'Base', 'Base.run']],
  tsx: ['a.tsx', `export function Button({ label }: Props) { return <button>{label}</button>; }
export const Card = () => <div className="card" />;
class Panel extends React.Component { render() { return <section/>; } }
interface Props { label: string }`,
    ['Button', 'Card', 'Panel', 'Panel.render', 'Props']],
  javascript: ['a.js', `const fs = require('fs');
class Queue { push(x) {} pop() {} }
function drain(q) { const tmp = []; return tmp; }
export const retry = (fn) => fn();
module.exports = { drain };`,
    ['fs', 'Queue', 'Queue.push', 'Queue.pop', 'drain', 'retry']],
  python: ['a.py', `import os
class Invoice:
    def total(self):
        def helper():
            pass
        return 1
    @property
    def paid(self):
        return True
def charge(invoice):
    pass
@dataclass
class Line:
    qty: int`,
    ['Invoice', 'Invoice.total', 'Invoice.total.helper', 'Invoice.paid', 'charge', 'Line']],
  go: ['a.go', `package billing
type Invoice struct { ID string }
type Store interface { Get(id string) Invoice }
func (i Invoice) Total() int { return 0 }
func Charge(i Invoice) error { return nil }`,
    ['Invoice', 'Store', 'Store.Get', 'Total', 'Charge']],
  rust: ['a.rs', `use std::fmt;
pub struct Invoice { id: u32 }
pub enum Status { Open }
pub trait Store { fn get(&self) -> Invoice; }
impl Invoice { pub fn total(&self) -> u32 { 0 } }
pub fn charge() {}
mod inner { pub fn helper() {} }
type Id = u32;
const MAX: u32 = 3;
macro_rules! log { () => {} }`,
    ['Invoice', 'Status', 'Store', 'Store.get', 'total', 'charge', 'inner', 'inner.helper', 'Id', 'MAX', 'log']],
  java: ['A.java', `package billing;
import java.util.List;
public class InvoiceService {
  public InvoiceService() {}
  public Invoice get(String id) { return null; }
  private static List<Invoice> all() { return null; }
  enum Mode { A, B }
}
interface Store { Invoice find(String id); }
record Line(int qty) {}
@interface Audited {}`,
    ['InvoiceService', 'InvoiceService.InvoiceService', 'InvoiceService.get', 'InvoiceService.all', 'InvoiceService.Mode', 'Store', 'Store.find', 'Line', 'Audited']],
  c_sharp: ['A.cs', `using System;
namespace Billing.Api
{
    public class OrderService : IOrderService
    {
        public OrderService(IRepo repo) {}
        public Order Get(int id) { return null; }
        public async Task<List<Order>> ListAsync() { return null; }
        public int Count { get; set; }
    }
    public interface IOrderService { Order Get(int id); }
    public record OrderDto(int Id);
    public struct Point { public int X; }
    public enum State { Open }
    public delegate void Changed();
}`,
    ['OrderService', 'OrderService.OrderService', 'OrderService.Get', 'OrderService.ListAsync', 'OrderService.Count', 'IOrderService', 'IOrderService.Get', 'OrderDto', 'Point', 'State', 'Changed']],
  c_sharp_file_scoped: ['B.cs', `namespace Billing.Domain;
public sealed class Product
{
    public Money Price() => default;
}`,
    ['Product', 'Product.Price']],
  kotlin: ['a.kt', `package billing
class Invoice(val id: String) {
  fun total(): Int { val local = 1; return local }
  val cached = 2
}
val TOP = 3
interface Store { fun get(id: String): Invoice }
object Registry { fun all() = listOf<Invoice>() }
fun charge(i: Invoice) {}
data class Line(val qty: Int)`,
    ['Invoice', 'Invoice.total', 'Invoice.cached', 'Store', 'Store.get', 'Registry', 'Registry.all', 'charge', 'Line', 'TOP']],
  scala: ['a.scala', `package billing
class Invoice { def total(): Int = 0 }
trait Store { def get(id: String): Invoice }
object Registry { def all(): List[Invoice] = Nil }
case class Line(qty: Int)`,
    ['Invoice', 'Invoice.total', 'Store', 'Store.get', 'Registry', 'Registry.all', 'Line']],
  swift: ['a.swift', `import Foundation
class Invoice {
  var id: String = ""
  init() {}
  func total() -> Int { var local = 0; return local }
}
struct Line { let qty: Int }
protocol Store { func get(id: String) -> Invoice }
enum Status { case open }
func charge() {}
typealias Id = String`,
    ['Invoice', 'Invoice.id', 'Invoice.init', 'Invoice.total', 'Line', 'Line.qty', 'Store', 'Store.get', 'Status', 'charge', 'Id']],
  dart: ['a.dart', `import 'x.dart';
class Invoice {
  Invoice();
  int total() { return 0; }
}
mixin Audited {}
enum Status { open }
extension Money on Invoice {}
void charge() {}`,
    ['Invoice', 'Invoice.Invoice', 'Invoice.total', 'Audited', 'Status', 'Money', 'charge']],
  php: ['a.php', `<?php
namespace Billing;
class Invoice {
  public function total(): int { return 0; }
}
interface Store { public function get($id); }
trait Audited {}
function charge() {}`,
    ['Invoice', 'Invoice.total', 'Store', 'Store.get', 'Audited', 'charge']],
  ruby: ['a.rb', `module Billing
  class Invoice
    def total
      0
    end
    def self.build
    end
  end
end
def charge; end`,
    ['Billing', 'Billing.Invoice', 'Billing.Invoice.total', 'Billing.Invoice.build', 'charge']],
  c: ['a.c', `#include <stdio.h>
struct invoice { int id; };
enum status { OPEN };
typedef struct { int qty; } line_t;
static int total(struct invoice *inv) { return 0; }
int *make(void) { return 0; }
union value { int i; float f; };`,
    ['invoice', 'status', 'line_t', 'total', 'make', 'value']],
  cpp: ['a.cpp', `#include <vector>
namespace billing {
class Invoice {
 public:
  int total() const { return 0; }
};
struct Line {};
enum class Status { Open };
}
int billing::helper() { return 1; }
template <typename T> class Box {};
extern "C" { int legacy(void) { return 0; } }`,
    ['Invoice', 'Invoice.total', 'Line', 'Status', 'helper', 'Box', 'legacy']],
  objc: ['a.m', `#import <Foundation/Foundation.h>
@interface Invoice : NSObject
- (int)total;
@end
@implementation Invoice
- (int)total { return 0; }
@end
@protocol Store
@end
int charge(void) { return 0; }`,
    ['Invoice', 'Invoice.total', 'Store', 'charge']],
  lua: ['a.lua', `local M = {}
local function helper() end
function M.total() return 0 end
function charge() end
return M`,
    ['helper', 'M.total', 'charge']],
  bash: ['a.sh', `#!/bin/bash
set -e
deploy() { echo deploy; }
function rollback { echo back; }`,
    ['deploy', 'rollback']],
  elixir: ['a.ex', `defmodule Billing.Invoice do
  use Ecto.Schema
  alias Billing.Line
  def total(invoice), do: 0
  defp helper(x) when x > 0 do
    x
  end
  defmacro audited, do: nil
end`,
    ['Billing.Invoice', 'Billing.Invoice.total', 'Billing.Invoice.helper', 'Billing.Invoice.audited']],
  ocaml: ['a.ml', `module Billing = struct
  let total x = x
end
type status = Open | Closed
let charge () = let inner = 2 in inner
let (a, b) = (1, 2)
let () = print_endline "x"
module type STORE = sig end`,
    ['Billing', 'Billing.total', 'status', 'charge', 'STORE']],
  zig: ['a.zig', `const std = @import("std");
const Invoice = struct {
    id: u32,
    fn total() u32 { const local = 1; return local; }
};
pub fn charge() void {}`,
    ['std', 'Invoice', 'Invoice.total', 'charge']],
  solidity: ['a.sol', `pragma solidity ^0.8.0;
contract Invoice {
  event Paid();
  struct Line { uint qty; }
  modifier onlyOwner() { _; }
  function total() public view returns (uint) { return 0; }
}
interface Store {}
library MathLib {}`,
    ['Invoice', 'Invoice.Paid', 'Invoice.Line', 'Invoice.onlyOwner', 'Invoice.total', 'Store', 'MathLib']],
  rescript: ['a.res', `type status = Open | Closed
let total = x => { let local = 2; x + local }
module Billing = { let charge = () => () }`,
    ['status', 'total', 'Billing', 'Billing.charge']],
  elisp: ['a.el', `(defun billing-total (x) x)
(defvar billing-rate 1)
(defmacro billing-audited () nil)`,
    ['billing-total', 'billing-audited']],
  systemrdl: ['a.rdl', `addrmap top {
  reg ctrl_r { field { sw = rw; } en[0:0]; };
};`,
    ['top', 'top.ctrl_r']],
  tlaplus: ['a.tla', `---- MODULE Billing ----
EXTENDS Naturals
Init == x = 0
Next == x' = x + 1
====`,
    ['Billing', 'Billing.Init', 'Billing.Next']],
  vue: ['a.vue', `<template>
  <div>{{ total }}</div>
</template>
<script setup lang="ts">
import { ref } from 'vue';
const total = ref(0);
function charge(): void {}
</script>
<style>.a { color: red; }</style>`,
    ['total', 'charge']],
  elm: ['a.elm', `module Billing exposing (..)

import Html exposing (div)

type Status = Open | Closed

type alias Invoice = { id : Int }

total : Invoice -> Int
total invoice =
    let
        local = 1
    in
    invoice.id + local

port charge : Int -> Cmd msg`,
    ['Billing', 'Status', 'Invoice', 'total', 'charge']],
  ql: ['a.ql', `import javascript

module Billing {
  predicate inner() { any() }
}

class Charge extends DataFlow::Node {
  Charge() { this = this }
  string describe() { result = "x" }
}

predicate risky(Charge c) { any() }

from Charge c
where risky(c)
select c, "found"`,
    ['Billing', 'Billing.inner', 'Charge', 'Charge.describe', 'risky']],
  yaml: ['a.yml', `name: ci
on:
  push:
    branches: [main]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: npm test`, []],
  css: ['a.css', `.a { color: red; }\n@media (max-width: 1px) { .b { color: blue; } }`, []],
  html: ['a.html', `<!doctype html><html><body><div>x</div></body></html>`, []],
  json: ['a.json', `{ "name": "x", "version": "1.0.0" }`, []],
  toml: ['a.toml', `[package]\nname = "x"\n[dependencies]\nserde = "1"`, []],
  embedded_template: ['a.erb', `<h1><%= title %></h1>\n<% items.each do |i| %><li><%= i %></li><% end %>`, []],
};
