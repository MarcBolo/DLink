/**
 * ESLint 扁平配置（Flat Config）
 *
 * 目的：明确告诉 ESLint/编辑器插件「用本项目的 tsconfig 做类型化 lint」。
 * 缺少这份配置时，编辑器内置 lint 可能拿不到类型信息，把 Obsidian / DOM
 * 类型整体当成 error 类型，从而对几乎每一处调用误报
 * @typescript-eslint/no-unsafe-call、no-unsafe-assignment 等。
 *
 * 依赖：eslint、typescript-eslint、eslint-plugin-obsidianmd
 * （若编辑器提示找不到模块，在项目里执行：
 *   npm i -D eslint typescript-eslint eslint-plugin-obsidianmd）
 */
import { fileURLToPath } from 'node:url';
import tseslint from 'typescript-eslint';
import obsidianmd from 'eslint-plugin-obsidianmd';

const tsconfigRootDir = fileURLToPath(new URL('.', import.meta.url));

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/public/**',
      '**/*.js',
      '**/*.mjs',
      '**/*.cjs',
    ],
  },
  ...tseslint.configs.recommendedTypeChecked,
  {
    plugins: { obsidianmd },
    rules: {
      'obsidianmd/prefer-create-el': 'warn',
    },
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.json'],
        tsconfigRootDir,
      },
    },
  }
);
