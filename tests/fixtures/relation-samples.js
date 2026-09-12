// One sample per language for the relation rules: a call on a receiver, a
// plain call, an import and a base type, written the way each language writes
// them. The expectations live in the test; these are just the inputs.
export const RELATION_SAMPLES = {
  'a.py': `import os
from billing.domain import Invoice

class Service(BaseService, Store):
    def get(self, id):
        found = self.repo.find_by_id(id)
        validate(found)
        return Mapper.to_dto(found)`,
  'a.go': `package billing

import "billing/domain"

func (s Service) Get(id string) domain.Invoice {
  found := s.repo.FindByID(id)
  validate(found)
  return found
}`,
  'a.rs': `use crate::domain::Invoice;

impl Service {
  fn get(&self, id: u32) -> Invoice {
    let found = self.repo.find_by_id(id);
    validate(&found);
    found
  }
}`,
  'a.kt': `package billing
import billing.domain.Invoice

class Service(val repo: Repo) : BaseService(), Store {
  fun get(id: String): Invoice {
    val found = repo.findById(id)
    validate(found)
    return found
  }
}`,
  'a.scala': `package billing
import billing.domain.Invoice

class Service(repo: Repo) extends BaseService with Store {
  def get(id: String): Invoice = {
    val found = repo.findById(id)
    validate(found)
    found
  }
}`,
  'a.swift': `import Foundation

class Service: BaseService, Store {
  func get(id: String) -> Invoice {
    let found = repo.findById(id: id)
    validate(found)
    return found
  }
}`,
  'a.dart': `import 'package:billing/domain.dart';

class Service extends BaseService implements Store {
  Invoice get(String id) { return repo.findById(id); }
}`,
  'a.php': `<?php
namespace Billing;
use Billing\\Domain\\Invoice;

class Service extends BaseService implements Store {
  public function get($id) {
    $found = $this->repo->findById($id);
    validate($found);
    return Mapper::toDto($found);
  }
}`,
  'a.rb': `require 'billing/domain'

class Service < BaseService
  def get(id)
    found = @repo.find_by_id(id)
    validate(found)
  end
end`,
  'a.c': `#include "domain.h"

int total(struct invoice *inv) {
  int n = count_lines(inv);
  return n;
}`,
  'a.cpp': `#include "domain/invoice.h"

namespace billing {
class Service : public BaseService {
 public:
  Invoice Get(int id) { return repo_.FindById(id); }
};
}`,
  'a.m': `#import "Domain.h"

@implementation Service
- (Invoice *)get:(NSString *)id {
  return [self.repo findById:id];
}
@end`,
  'a.lua': `local domain = require("billing.domain")

function Service.get(id)
  local found = repo.findById(id)
  return found
end`,
  'a.sh': `#!/bin/bash
source ./lib/helpers.sh

deploy() {
  build_image
  push_image "$1"
}`,
  'a.ex': `defmodule Billing.Service do
  alias Billing.Domain.Invoice

  def get(id) do
    found = Repo.find_by_id(id)
    validate(found)
  end
end`,
  'a.ml': `open Billing_domain

let get id =
  let found = Repo.find_by_id id in
  validate found`,
  'a.zig': `const std = @import("std");

pub fn get(id: u32) Invoice {
    const found = repo.findById(id);
    return found;
}`,
  'a.sol': `import "./Domain.sol";

contract Service is BaseService {
  function get(uint id) public returns (uint) { return repo.findById(id); }
}`,
  'a.res': `open BillingDomain

let get = id => {
  let found = Repo.findById(id)
  validate(found)
}`,
  'a.elm': `module Billing exposing (..)

import Domain exposing (Invoice)

total : Invoice -> Int
total invoice =
    add (value invoice) 1`,
  'a.ql': `import javascript

class Charge extends DataFlow::Node {
  string describe() { result = name() }
}`,
  'a.tla': `---- MODULE Billing ----
EXTENDS Naturals
Helper(n) == n + 1
Next == Helper(3)
====`,
  'a.el': `(require (quote billing-domain))

(defun billing-get (id)
  (let ((found (repo-find-by-id id)))
    (validate found)))`,
  'a.ts': `import { Repo } from './repo.js';
export class Service extends Base implements Store {
  get(id: string) { return this.repo.findById(id); }
}`,
};
