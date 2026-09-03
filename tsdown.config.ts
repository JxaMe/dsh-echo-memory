/**
 * dsh-echo-memory 双半侧构建，复刻官方包的两段式约定：
 *  1. 宿主半：tsc 产出 lib/types/*.js（NodeNext ESM），tsdown 从中打包出
 *     lib/*.js 运行时（依赖与 peer 保持外部，由 Node 在运行时解析）；
 *  2. 客户端半：从 src/client 打包 closure-factory artifact（浏览器模块表契约）。
 * 官方预设位于仓库 packages/client/tsdown.client.ts（本包在仓库之外，需自行复刻）；
 * 本插件不携带 CSS，故不复制其 CSS 插件部分。
 */
import type { UserConfig } from 'tsdown'

/** 官方 platform.ts 的基线外部：shell 共享模块表条目 (alpha.2: dsh-client-runtime -> dsh-client-store) */
const BASELINE_EXTERNALS: ReadonlySet<string> = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
])

export default [
  {
    name: 'dsh-echo-memory/host',
    entry: ['lib/types/index.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2022',
    fixedExtension: false,
    dts: false,
    sourcemap: false,
    // tsdown 默认 clean 会清掉同目录其他产物，必须关掉。
    clean: false,
  },
  {
    name: 'dsh-echo-memory/client',
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: ['cjs'],
    platform: 'browser',
    target: 'es2022',
    // 类型走 tsc 产出的 lib/types（dts 在此开启会包装 banner/footer，破坏解析）。
    dts: false,
    sourcemap: true,
    loader: { '.png': 'base64' },
    // tsdown 默认 clean 会清掉 node 半侧产物，必须关掉。
    clean: false,
    deps: {
      // 基线条目保持 import，由浏览器模块表提供；其余依赖（含 @deepseek-ai 的
      // wire/type 层按官方 INLINE_SAFE 语义此处仅出现于本插件的实现依赖）内联进 bundle。
      neverBundle: (specifier: string): boolean => BASELINE_EXTERNALS.has(specifier),
      alwaysBundle: (specifier: string): boolean => !BASELINE_EXTERNALS.has(specifier),
    },
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
    },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: "dsh-echo-memory", factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
] satisfies UserConfig[]