# tiny-stack-vm-01

A tiny stack virtual machine for make.fun's ISA v1.

One run answers every instance in `/input/<id>/` (each with a
`program.bin` and an `input.bin`) and writes `/output/<id>/stdout.bin`
plus `/output/<id>/exit.txt` for each.

## The machine

- 32-bit two's-complement integers, wrapping on every arithmetic result
- 256-value data stack, 64-deep call stack, 256 words of memory
- 37 opcodes: stack ops, arithmetic, shifts, comparisons, jumps, calls,
  memory, input/output, exit
- 10 traps with their own exit codes (underflow 2, overflow 3, division
  by zero 4, bad opcode 5, memory 6, call depth 7, empty RET 8, pc 9,
  step limit 10, output limit 11)
- Step limit 1,000,000 instructions; output cap 65,536 bytes

## Run

```sh
node main.ts
```

With custom directories:

```sh
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Node 22 or later, no dependencies.
