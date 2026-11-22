// Tiny stack VM, make.fun ISA v1. One run answers every /input/<id>/
// (program.bin + input.bin) and writes /output/<id>/stdout.bin + exit.txt.
// Node 22+, no dependencies.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const IN = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUT = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
// Traps: 2 underflow, 3 overflow, 4 div by zero, 5 bad opcode, 6 memory,
// 7 call depth, 8 empty RET, 9 pc, 10 step limit, 11 output limit.
const O = {
  HALT: 0, PUSH8: 1, PUSH32: 2, POP: 3, DUP: 4, SWAP: 5, OVER: 6, ROT: 7,
  ADD: 16, SUB: 17, MUL: 18, DIV: 19, MOD: 20, DIVU: 21, MODU: 22,
  NEG: 23, AND: 24, OR: 25, XOR: 26, NOT: 27, SHL: 28, SHR: 29, SHRU: 30,
  EQ: 32, LT: 33, LTU: 34,
  JMP: 48, JZ: 49, JNZ: 50, CALL: 51, RET: 52,
  LOAD: 64, STORE: 65, PRINT: 80, PUTC: 81, IN: 82, EXIT: 83,
};
// Immediate length in bytes.
const imm = (op: number) =>
  op === 1 ? 1 : op === 2 ? 4 : op >= 48 && op <= 51 ? 2 : 0;
// True for the 37 opcode bytes.
const valid = (op: number) =>
  op <= 7 || (op >= 16 && op <= 30) || (op >= 32 && op <= 34) ||
  (op >= 48 && op <= 52) || op === 64 || op === 65 || (op >= 80 && op <= 83);
// True for the 15 two-operand opcodes (a b -- r).
const binop = (op: number) =>
  (op >= 16 && op <= 22) || (op >= 24 && op <= 26) ||
  (op >= 28 && op <= 30) || (op >= 32 && op <= 34);
// [pops, pushes] for the stack checks.
function effect(op: number): [number, number] {
  if (op === 1 || op === 2 || op === 82) return [0, 1]; // PUSH8, PUSH32, IN
  if (op === 7) return [3, 3]; // ROT
  if (op === 6) return [2, 3]; // OVER
  if (op === 4) return [1, 2]; // DUP
  if (op === 5) return [2, 2]; // SWAP
  if (op === 65) return [2, 0]; // STORE
  if (op === 64) return [1, 1]; // LOAD
  if (binop(op)) return [2, 1];
  if (op === 3 || op === 23 || op === 27 || op === 49 || op === 50 ||
      op === 80 || op === 81 || op === 83) return [1, 0];
  return [0, 0]; // HALT, JMP, CALL, RET
}

function run(prog: Uint8Array, input: Uint8Array): [Uint8Array, number] {
  const S = new Int32Array(256); let sp = 0;
  const C = new Int32Array(64); let cp = 0;
  const M = new Int32Array(256);
  const out = new Uint8Array(65536); let len = 0;
  let ipos = 0, pc = 0, steps = 0;
  const n = prog.length;
  const done = (code: number): [Uint8Array, number] => [out.slice(0, len), code];

  for (;;) {
    // Trap order: step limit, pc range, bad opcode, cut-off immediate,
    // then stack checks, then the instruction's own traps.
    if (steps === 1000000) return done(10);
    if (pc < 0 || pc >= n) return done(9);
    const op = prog[pc];
    if (!valid(op)) return done(5);
    const im = imm(op);
    if (pc + im >= n) return done(9);
    steps++;
    const next = pc + 1 + im;
    const [pops, pushes] = effect(op);
    if (sp < pops) return done(2);
    if (sp - pops + pushes > 256) return done(3);
    pc = next;

    if (op === O.HALT) return done(0);
    if (op === O.PUSH8) S[sp++] = (prog[next - 1] << 24) >> 24; // sign-extended
    else if (op === O.PUSH32) {
      S[sp++] = prog[next - 4] | (prog[next - 3] << 8) |
        (prog[next - 2] << 16) | (prog[next - 1] << 24);
    } else if (op === O.POP) sp--;
    else if (op === O.DUP) { S[sp] = S[sp - 1]; sp++; }
    else if (op === O.SWAP) {
      const t = S[sp - 1]; S[sp - 1] = S[sp - 2]; S[sp - 2] = t;
    } else if (op === O.OVER) { S[sp] = S[sp - 2]; sp++; }
    else if (op === O.ROT) {
      const a = S[sp - 3];
      S[sp - 3] = S[sp - 2]; S[sp - 2] = S[sp - 1]; S[sp - 1] = a;
    } else if (op === O.NEG) S[sp - 1] = -S[sp - 1] | 0;
    else if (op === O.NOT) S[sp - 1] = ~S[sp - 1];
    else if (op === O.JMP || op === O.JZ || op === O.JNZ) {
      const off = ((prog[next - 2] | (prog[next - 1] << 8)) << 16) >> 16;
      let take = op === O.JMP;
      if (op !== O.JMP) {
        const v = S[--sp];
        take = op === O.JZ ? v === 0 : v !== 0;
      }
      if (take) pc = next + off;
    } else if (op === O.CALL) {
      if (cp === 64) return done(7);
      C[cp++] = next;
      pc = prog[next - 2] | (prog[next - 1] << 8);
    } else if (op === O.RET) {
      if (cp === 0) return done(8);
      pc = C[--cp];
    } else if (op === O.LOAD) {
      const a = S[sp - 1];
      if (a < 0 || a > 255) return done(6);
      S[sp - 1] = M[a];
    } else if (op === O.STORE) {
      const a = S[sp - 1], v = S[sp - 2];
      if (a < 0 || a > 255) return done(6);
      sp -= 2;
      M[a] = v;
    } else if (op === O.PRINT) {
      const b = Buffer.from(String(S[sp - 1]), 'ascii');
      if (len + b.length > 65536) return done(11);
      sp--;
      out.set(b, len);
      len += b.length;
    } else if (op === O.PUTC) {
      if (len + 1 > 65536) return done(11);
      out[len++] = S[--sp] & 255;
    } else if (op === O.IN) {
      S[sp++] = ipos < input.length ? input[ipos++] : -1;
    } else if (op === O.EXIT) {
      return done(S[--sp] & 255);
    } else {
      // Binary ops: ( a b -- r ), b on top.
      const b = S[sp - 1], a = S[sp - 2];
      let r: number;
      if (op === O.ADD) r = (a + b) | 0;
      else if (op === O.SUB) r = (a - b) | 0;
      else if (op === O.MUL) r = Math.imul(a, b);
      else if (op === O.DIV) {
        if (b === 0) return done(4);
        r = a === -2147483648 && b === -1 ? a : (a / b) | 0;
      } else if (op === O.MOD) {
        if (b === 0) return done(4);
        r = b === -1 ? 0 : (a % b) | 0;
      } else if (op === O.DIVU) {
        if (b === 0) return done(4);
        r = Math.floor((a >>> 0) / (b >>> 0)) | 0;
      } else if (op === O.MODU) {
        if (b === 0) return done(4);
        r = ((a >>> 0) % (b >>> 0)) | 0;
      } else if (op === O.AND) r = a & b;
      else if (op === O.OR) r = a | b;
      else if (op === O.XOR) r = a ^ b;
      else if (op === O.SHL) r = a << (b & 31);
      else if (op === O.SHR) r = a >> (b & 31);
      else if (op === O.SHRU) r = (a >>> (b & 31)) | 0;
      else if (op === O.EQ) r = a === b ? 1 : 0;
      else if (op === O.LT) r = a < b ? 1 : 0;
      else r = (a >>> 0) < (b >>> 0) ? 1 : 0; // LTU
      sp -= 2;
      S[sp++] = r;
    }
  }
}

// Driver: answer every instance in IN, one per subdirectory.
for (const e of readdirSync(IN, { withFileTypes: true })) {
  if (!e.isDirectory()) continue;
  const dir = join(IN, e.name);
  const [stdout, exit] = run(
    readFileSync(join(dir, 'program.bin')),
    readFileSync(join(dir, 'input.bin')),
  );
  const od = join(OUT, e.name);
  mkdirSync(od, { recursive: true });
  writeFileSync(join(od, 'stdout.bin'), stdout);
  writeFileSync(join(od, 'exit.txt'), exit + '\n');
}
