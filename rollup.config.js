import typescript from "@rollup/plugin-typescript";
import { nodeResolve } from "@rollup/plugin-node-resolve";
import commonjs from "@rollup/plugin-commonjs";

const isProduction = process.env.NODE_ENV === "production";

export default {
  input: "src/main.ts",
  output: {
    dir: ".",
    sourcemap: isProduction ? false : "inline",
    format: "cjs",
    exports: "default",
  },
  external: ["obsidian"],
  plugins: [
    typescript({ tsconfig: "./tsconfig.json" }),
    nodeResolve({ browser: true }),
    commonjs(),
  ],
};
