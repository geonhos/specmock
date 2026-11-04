#!/usr/bin/env node
import { Command } from "commander";
import { VERSION } from "@specmock/core";

const program = new Command();
program.name("specmock").description("스펙에서 필요한 기능만 골라 mock 서버를 생성한다").version(VERSION);
program.parseAsync(process.argv);
