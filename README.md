# tiny-stack-vm-01

A tiny stack virtual machine for make.fun's ISA v1: 32-bit wrapping
integers, a 256-value stack, a 64-deep call stack, 256 words of memory,
37 opcodes and 10 traps. One run answers every instance in
`/input/<id>/` and writes `/output/<id>/stdout.bin` + `exit.txt`.

Run: `node main.ts` (Node 22+, no dependencies).
