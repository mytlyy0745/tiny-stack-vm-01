// Tiny stack VM for make.fun ISA v1 (see kit ISA.md).
// One run answers every instance in /input/<id>/ and writes
// /output/<id>/stdout.bin + /output/<id>/exit.txt.
// Runs on Node 22+ (type stripping), no dependencies.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const IN_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const STACK_CAP = 256;
const CALL_CAP = 64;
const MEM_WORDS = 256;
const STEP_CAP = 1_000_000;
const OUT_CAP = 65_536;

// Trap exit codes, ISA.md "Traps".
const T_UNDERFLOW = 2;
const T_OVERFLOW = 3;
const T_DIVZERO = 4;
const T_BADOP = 5;
const T_MEM = 6;
const T_CALLDEPTH = 7;
const T_RETEMPTY = 8;
const T_PC = 9;
const T_STEPS = 10;
const T_OUTPUT = 11;

// Opcode bytes (ISA.md table).
const OP = {
  HALT: 0x00, PUSH8: 0x01, PUSH32: 0x02, POP: 0x03, DUP: 0x04,
  SWAP: 0x05, OVER: 0x06, ROT: 0x07,
  ADD: 0x10, SUB: 0x11, MUL: 0x12, DIV: 0x13, MOD: 0x14,
  DIVU: 0x15, MODU: 0x16, NEG: 0x17, AND: 0x18, OR: 0x19,
  XOR: 0x1a, NOT: 0x1b, SHL: 0x1c, SHR: 0x1d, SHRU: 0x1e,
  EQ: 0x20, LT: 0x21, LTU: 0x22,
  JMP: 0x30, JZ: 0x31, JNZ: 0x32, CALL: 0x33, RET: 0x34,
  LOAD: 0x40, STORE: 0x41,
  PRINT: 0x50, PUTC: 0x51, IN: 0x52, EXIT: 0x53,
} as const;

// Immediate length in bytes for each opcode (0 for most).
function immLen(op: number): number {
  if (op === OP.PUSH8) return 1;
  if (op === OP.PUSH32) return 4;
  if (op === OP.JMP || op === OP.JZ || op === OP.JNZ || op === OP.CALL) return 2;
  return 0;
}

// How many values an opcode pops and pushes, for the stack checks.
function stackEffect(op: number): [number, number] {
  switch (op) {
    case OP.PUSH8: case OP.PUSH32: case OP.IN: return [0, 1];
    case OP.POP: case OP.NEG: case OP.NOT: case OP.PRINT:
    case OP.PUTC: case OP.EXIT: case OP.JZ: case OP.JNZ: return [1, 0];
    case OP.DUP: return [1, 2];
    case OP.SWAP: case OP.STORE: return [2, 0];
    case OP.OVER: return [2, 3];
    case OP.ROT: return [3, 3];
    case OP.LOAD: return [1, 1];
    case OP.ADD: case OP.SUB: case OP.MUL: case OP.DIV: case OP.MOD:
    case OP.DIVU: case OP.MODU: case OP.AND: case OP.OR: case OP.XOR:
    case OP.SHL: case OP.SHR: case OP.SHRU: case OP.EQ: case OP.LT:
    case OP.LTU: return [2, 1];
    default: return [0, 0]; // HALT, JMP, CALL, RET
  }
}

function isOpcode(op: number): boolean {
  if (op <= 0x07) return true;
  if (op >= 0x10 && op <= 0x1e && op !== 0x1f) return true;
  if (op >= 0x20 && op <= 0x22) return true;
  if (op >= 0x30 && op <= 0x34) return true;
  if (op === 0x40 || op === 0x41) return true;
  if (op >= 0x50 && op <= 0x53) return true;
  return false;
}

// Runs one program on one input. Returns [stdout bytes, exit code].
function run(prog: Uint8Array, input: Uint8Array): [Uint8Array, number] {
  const stack = new Int32Array(STACK_CAP);
  let sp = 0;
  const calls = new Int32Array(CALL_CAP);
  let cp = 0;
  const mem = new Int32Array(MEM_WORDS);
  const out = new Uint8Array(OUT_CAP);
  let outLen = 0;
  let inPos = 0;
  let pc = 0;
  let steps = 0;
  const end = prog.length;
  const finish = (code: number): [Uint8Array, number] => [out.slice(0, outLen), code];

  for (;;) {
    // Trap order (ISA.md "One step"): step limit, pc range, bad opcode,
    // cut-off immediate, then stack checks, then the instruction's own traps.
    if (steps === STEP_CAP) return finish(T_STEPS);
    if (pc < 0 || pc >= end) return finish(T_PC);
    const op = prog[pc];
    if (!isOpcode(op)) return finish(T_BADOP);
    const imm = immLen(op);
    if (pc + imm >= end) return finish(T_PC);
    steps++;
    const next = pc + 1 + imm;
    const [pops, pushes] = stackEffect(op);
    if (sp < pops) return finish(T_UNDERFLOW);
    if (sp - pops + pushes > STACK_CAP) return finish(T_OVERFLOW);
    pc = next;

    if (op === OP.HALT) return finish(0);

    if (op === OP.PUSH8) {
      // Sign-extend the byte: 0xFF is -1.
      stack[sp++] = (prog[next - 1] << 24) >> 24;
    } else if (op === OP.PUSH32) {
      stack[sp++] =
        prog[next - 4] |
        (prog[next - 3] << 8) |
        (prog[next - 2] << 16) |
        (prog[next - 1] << 24);
    } else if (op === OP.POP) {
      sp--;
    } else if (op === OP.DUP) {
      stack[sp] = stack[sp - 1];
      sp++;
    } else if (op === OP.SWAP) {
      const tmp = stack[sp - 1];
      stack[sp - 1] = stack[sp - 2];
      stack[sp - 2] = tmp;
    } else if (op === OP.OVER) {
      stack[sp] = stack[sp - 2];
      sp++;
    } else if (op === OP.ROT) {
      const a = stack[sp - 3];
      stack[sp - 3] = stack[sp - 2];
      stack[sp - 2] = stack[sp - 1];
      stack[sp - 1] = a;
    } else if (op === OP.NEG) {
      stack[sp - 1] = -stack[sp - 1] | 0; // wraps: -INT_MIN stays INT_MIN
    } else if (op === OP.NOT) {
      stack[sp - 1] = ~stack[sp - 1];
    } else if (op === OP.JMP || op === OP.JZ || op === OP.JNZ) {
      const offset = ((prog[next - 2] | (prog[next - 1] << 8)) << 16) >> 16;
      let take = op === OP.JMP;
      if (op !== OP.JMP) {
        const v = stack[--sp];
        take = op === OP.JZ ? v === 0 : v !== 0;
      }
      if (take) pc = next + offset;
    } else if (op === OP.CALL) {
      if (cp === CALL_CAP) return finish(T_CALLDEPTH);
      calls[cp++] = next;
      pc = prog[next - 2] | (prog[next - 1] << 8);
    } else if (op === OP.RET) {
      if (cp === 0) return finish(T_RETEMPTY);
      pc = calls[--cp];
    } else if (op === OP.LOAD) {
      const addr = stack[sp - 1];
      if (addr < 0 || addr >= MEM_WORDS) return finish(T_MEM);
      stack[sp - 1] = mem[addr];
    } else if (op === OP.STORE) {
      const addr = stack[sp - 1];
      const val = stack[sp - 2];
      if (addr < 0 || addr >= MEM_WORDS) return finish(T_MEM);
      sp -= 2;
      mem[addr] = val;
    } else if (op === OP.PRINT) {
      const text = String(stack[sp - 1]);
      const bytes = Buffer.from(text, 'ascii');
      if (outLen + bytes.length > OUT_CAP) return finish(T_OUTPUT);
      sp--;
      out.set(bytes, outLen);
      outLen += bytes.length;
    } else if (op === OP.PUTC) {
      if (outLen + 1 > OUT_CAP) return finish(T_OUTPUT);
      out[outLen++] = stack[--sp] & 255;
    } else if (op === OP.IN) {
      stack[sp++] = inPos < input.length ? input[inPos++] : -1;
    } else if (op === OP.EXIT) {
      return finish(stack[--sp] & 255);
    } else {
      // Binary ops: ( a b -- r ), b is the top of the stack.
      const b = stack[sp - 1];
      const a = stack[sp - 2];
      let r: number;
      if (op === OP.ADD) r = (a + b) | 0;
      else if (op === OP.SUB) r = (a - b) | 0;
      else if (op === OP.MUL) r = Math.imul(a, b); // low 32 bits
      else if (op === OP.DIV) {
        if (b === 0) return finish(T_DIVZERO);
        r = a === -2147483648 && b === -1 ? a : (a / b) | 0;
      } else if (op === OP.MOD) {
        if (b === 0) return finish(T_DIVZERO);
        r = b === -1 ? 0 : (a % b) | 0; // remainder takes the sign of a
      } else if (op === OP.DIVU) {
        if (b === 0) return finish(T_DIVZERO);
        r = Math.floor((a >>> 0) / (b >>> 0)) | 0;
      } else if (op === OP.MODU) {
        if (b === 0) return finish(T_DIVZERO);
        r = ((a >>> 0) % (b >>> 0)) | 0;
      } else if (op === OP.AND) r = a & b;
      else if (op === OP.OR) r = a | b;
      else if (op === OP.XOR) r = a ^ b;
      else if (op === OP.SHL) r = a << (b & 31);
      else if (op === OP.SHR) r = a >> (b & 31); // arithmetic
      else if (op === OP.SHRU) r = (a >>> (b & 31)) | 0; // logical
      else if (op === OP.EQ) r = a === b ? 1 : 0;
      else if (op === OP.LT) r = a < b ? 1 : 0;
      else r = (a >>> 0) < (b >>> 0) ? 1 : 0; // LTU
      sp -= 2;
      stack[sp++] = r;
    }
  }
}


// Driver: answer every instance in IN_DIR, one per subdirectory.
for (const entry of readdirSync(IN_DIR, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const id = entry.name;
  const dir = join(IN_DIR, id);
  const program = readFileSync(join(dir, 'program.bin'));
  const input = readFileSync(join(dir, 'input.bin'));
  const [stdout, exitCode] = run(program, input);
  const outDir = join(OUT_DIR, id);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'stdout.bin'), stdout);
  writeFileSync(join(outDir, 'exit.txt'), exitCode + '\n');
}
