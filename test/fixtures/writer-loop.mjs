// Child process: writes trees A and B alternately to a path, `count` times.
import { write } from "../../dist/index.js";
import { generate } from "../../bench/gen.mjs";

const [path, count] = [process.argv[2], Number(process.argv[3])];
const trees = [generate(1, 3000), generate(2, 3000)];
for (let i = 0; i < count; i++) write(path, trees[i % 2]);
