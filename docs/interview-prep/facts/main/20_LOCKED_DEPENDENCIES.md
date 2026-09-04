# 主仓库锁定依赖事实

来源：当前工作树 package-lock.json 与 tracked requirements.txt。package-lock.json 当前有未提交修改。

- lockfile name：xiaohongshu-relay-scraper-ui
- lockfile version 字段：3.0.0
- lockfileVersion：3
- packages 条目：245
- packages 中 dev=true：143
- packages 中 optional=true：53

## Python requirements

| 包          | 固定版本 |
| ----------- | -------- |
| openpyxl    | 3.1.5    |
| Pillow      | 12.3.0   |
| playwright  | 1.57.0   |
| pypdf       | 5.9.0    |
| pytest      | 8.4.1    |
| jsonschema  | 4.26.0   |
| python-docx | 1.1.2    |
| websockets  | 16.0     |

## npm lock packages 完整表

| 序号 | package path                                          | version       | dev   | optional | dependency 数 | optional dependency 数 | engine node                                                       |
| ---: | ----------------------------------------------------- | ------------- | ----- | -------- | ------------: | ---------------------: | ----------------------------------------------------------------- |
|    1 | [root]                                                | 3.0.0         | false | false    |             7 |                      0 |                                                                   |
|    2 | node_modules/@babel/code-frame                        | 7.29.7        | true  | false    |             3 |                      0 | >=6.9.0                                                           |
|    3 | node_modules/@babel/compat-data                       | 7.29.7        | true  | false    |             0 |                      0 | >=6.9.0                                                           |
|    4 | node_modules/@babel/core                              | 7.29.7        | true  | false    |            15 |                      0 | >=6.9.0                                                           |
|    5 | node_modules/@babel/generator                         | 7.29.7        | true  | false    |             5 |                      0 | >=6.9.0                                                           |
|    6 | node_modules/@babel/helper-compilation-targets        | 7.29.7        | true  | false    |             5 |                      0 | >=6.9.0                                                           |
|    7 | node_modules/@babel/helper-globals                    | 7.29.7        | true  | false    |             0 |                      0 | >=6.9.0                                                           |
|    8 | node_modules/@babel/helper-module-imports             | 7.29.7        | true  | false    |             2 |                      0 | >=6.9.0                                                           |
|    9 | node_modules/@babel/helper-module-transforms          | 7.29.7        | true  | false    |             3 |                      0 | >=6.9.0                                                           |
|   10 | node_modules/@babel/helper-plugin-utils               | 7.29.7        | true  | false    |             0 |                      0 | >=6.9.0                                                           |
|   11 | node_modules/@babel/helper-string-parser              | 7.29.7        | true  | false    |             0 |                      0 | >=6.9.0                                                           |
|   12 | node_modules/@babel/helper-validator-identifier       | 7.29.7        | true  | false    |             0 |                      0 | >=6.9.0                                                           |
|   13 | node_modules/@babel/helper-validator-option           | 7.29.7        | true  | false    |             0 |                      0 | >=6.9.0                                                           |
|   14 | node_modules/@babel/helpers                           | 7.29.7        | true  | false    |             2 |                      0 | >=6.9.0                                                           |
|   15 | node_modules/@babel/parser                            | 7.29.7        | true  | false    |             1 |                      0 | >=6.0.0                                                           |
|   16 | node_modules/@babel/plugin-transform-react-jsx-self   | 7.29.7        | true  | false    |             1 |                      0 | >=6.9.0                                                           |
|   17 | node_modules/@babel/plugin-transform-react-jsx-source | 7.29.7        | true  | false    |             1 |                      0 | >=6.9.0                                                           |
|   18 | node_modules/@babel/template                          | 7.29.7        | true  | false    |             3 |                      0 | >=6.9.0                                                           |
|   19 | node_modules/@babel/traverse                          | 7.29.7        | true  | false    |             7 |                      0 | >=6.9.0                                                           |
|   20 | node_modules/@babel/types                             | 7.29.7        | true  | false    |             2 |                      0 | >=6.9.0                                                           |
|   21 | node_modules/@esbuild/aix-ppc64                       | 0.25.12       | true  | true     |             0 |                      0 | >=18                                                              |
|   22 | node_modules/@esbuild/android-arm                     | 0.25.12       | true  | true     |             0 |                      0 | >=18                                                              |
|   23 | node_modules/@esbuild/android-arm64                   | 0.25.12       | true  | true     |             0 |                      0 | >=18                                                              |
|   24 | node_modules/@esbuild/android-x64                     | 0.25.12       | true  | true     |             0 |                      0 | >=18                                                              |
|   25 | node_modules/@esbuild/darwin-arm64                    | 0.25.12       | true  | true     |             0 |                      0 | >=18                                                              |
|   26 | node_modules/@esbuild/darwin-x64                      | 0.25.12       | true  | true     |             0 |                      0 | >=18                                                              |
|   27 | node_modules/@esbuild/freebsd-arm64                   | 0.25.12       | true  | true     |             0 |                      0 | >=18                                                              |
|   28 | node_modules/@esbuild/freebsd-x64                     | 0.25.12       | true  | true     |             0 |                      0 | >=18                                                              |
|   29 | node_modules/@esbuild/linux-arm                       | 0.25.12       | true  | true     |             0 |                      0 | >=18                                                              |
|   30 | node_modules/@esbuild/linux-arm64                     | 0.25.12       | true  | true     |             0 |                      0 | >=18                                                              |
|   31 | node_modules/@esbuild/linux-ia32                      | 0.25.12       | true  | true     |             0 |                      0 | >=18                                                              |
|   32 | node_modules/@esbuild/linux-loong64                   | 0.25.12       | true  | true     |             0 |                      0 | >=18                                                              |
|   33 | node_modules/@esbuild/linux-mips64el                  | 0.25.12       | true  | true     |             0 |                      0 | >=18                                                              |
|   34 | node_modules/@esbuild/linux-ppc64                     | 0.25.12       | true  | true     |             0 |                      0 | >=18                                                              |
|   35 | node_modules/@esbuild/linux-riscv64                   | 0.25.12       | true  | true     |             0 |                      0 | >=18                                                              |
|   36 | node_modules/@esbuild/linux-s390x                     | 0.25.12       | true  | true     |             0 |                      0 | >=18                                                              |
|   37 | node_modules/@esbuild/linux-x64                       | 0.25.12       | true  | true     |             0 |                      0 | >=18                                                              |
|   38 | node_modules/@esbuild/netbsd-arm64                    | 0.25.12       | true  | true     |             0 |                      0 | >=18                                                              |
|   39 | node_modules/@esbuild/netbsd-x64                      | 0.25.12       | true  | true     |             0 |                      0 | >=18                                                              |
|   40 | node_modules/@esbuild/openbsd-arm64                   | 0.25.12       | true  | true     |             0 |                      0 | >=18                                                              |
|   41 | node_modules/@esbuild/openbsd-x64                     | 0.25.12       | true  | true     |             0 |                      0 | >=18                                                              |
|   42 | node_modules/@esbuild/openharmony-arm64               | 0.25.12       | true  | true     |             0 |                      0 | >=18                                                              |
|   43 | node_modules/@esbuild/sunos-x64                       | 0.25.12       | true  | true     |             0 |                      0 | >=18                                                              |
|   44 | node_modules/@esbuild/win32-arm64                     | 0.25.12       | true  | true     |             0 |                      0 | >=18                                                              |
|   45 | node_modules/@esbuild/win32-ia32                      | 0.25.12       | true  | true     |             0 |                      0 | >=18                                                              |
|   46 | node_modules/@esbuild/win32-x64                       | 0.25.12       | true  | true     |             0 |                      0 | >=18                                                              |
|   47 | node_modules/@hono/node-server                        | 2.1.0         | false | false    |             0 |                      0 | >=20                                                              |
|   48 | node_modules/@jridgewell/gen-mapping                  | 0.3.13        | true  | false    |             2 |                      0 |                                                                   |
|   49 | node_modules/@jridgewell/remapping                    | 2.3.5         | true  | false    |             2 |                      0 |                                                                   |
|   50 | node_modules/@jridgewell/resolve-uri                  | 3.1.2         | true  | false    |             0 |                      0 | >=6.0.0                                                           |
|   51 | node_modules/@jridgewell/sourcemap-codec              | 1.5.5         | true  | false    |             0 |                      0 |                                                                   |
|   52 | node_modules/@jridgewell/trace-mapping                | 0.3.31        | true  | false    |             2 |                      0 |                                                                   |
|   53 | node_modules/@modelcontextprotocol/sdk                | 1.30.0        | false | false    |            17 |                      0 | >=18                                                              |
|   54 | node_modules/@playwright/test                         | 1.55.1        | true  | false    |             1 |                      0 | >=18                                                              |
|   55 | node_modules/@rolldown/pluginutils                    | 1.0.0-beta.27 | true  | false    |             0 |                      0 |                                                                   |
|   56 | node_modules/@rollup/rollup-android-arm-eabi          | 4.62.3        | true  | true     |             0 |                      0 |                                                                   |
|   57 | node_modules/@rollup/rollup-android-arm64             | 4.62.3        | true  | true     |             0 |                      0 |                                                                   |
|   58 | node_modules/@rollup/rollup-darwin-arm64              | 4.62.3        | true  | true     |             0 |                      0 |                                                                   |
|   59 | node_modules/@rollup/rollup-darwin-x64                | 4.62.3        | true  | true     |             0 |                      0 |                                                                   |
|   60 | node_modules/@rollup/rollup-freebsd-arm64             | 4.62.3        | true  | true     |             0 |                      0 |                                                                   |
|   61 | node_modules/@rollup/rollup-freebsd-x64               | 4.62.3        | true  | true     |             0 |                      0 |                                                                   |
|   62 | node_modules/@rollup/rollup-linux-arm-gnueabihf       | 4.62.3        | true  | true     |             0 |                      0 |                                                                   |
|   63 | node_modules/@rollup/rollup-linux-arm-musleabihf      | 4.62.3        | true  | true     |             0 |                      0 |                                                                   |
|   64 | node_modules/@rollup/rollup-linux-arm64-gnu           | 4.62.3        | true  | true     |             0 |                      0 |                                                                   |
|   65 | node_modules/@rollup/rollup-linux-arm64-musl          | 4.62.3        | true  | true     |             0 |                      0 |                                                                   |
|   66 | node_modules/@rollup/rollup-linux-loong64-gnu         | 4.62.3        | true  | true     |             0 |                      0 |                                                                   |
|   67 | node_modules/@rollup/rollup-linux-loong64-musl        | 4.62.3        | true  | true     |             0 |                      0 |                                                                   |
|   68 | node_modules/@rollup/rollup-linux-ppc64-gnu           | 4.62.3        | true  | true     |             0 |                      0 |                                                                   |
|   69 | node_modules/@rollup/rollup-linux-ppc64-musl          | 4.62.3        | true  | true     |             0 |                      0 |                                                                   |
|   70 | node_modules/@rollup/rollup-linux-riscv64-gnu         | 4.62.3        | true  | true     |             0 |                      0 |                                                                   |
|   71 | node_modules/@rollup/rollup-linux-riscv64-musl        | 4.62.3        | true  | true     |             0 |                      0 |                                                                   |
|   72 | node_modules/@rollup/rollup-linux-s390x-gnu           | 4.62.3        | true  | true     |             0 |                      0 |                                                                   |
|   73 | node_modules/@rollup/rollup-linux-x64-gnu             | 4.62.3        | true  | true     |             0 |                      0 |                                                                   |
|   74 | node_modules/@rollup/rollup-linux-x64-musl            | 4.62.3        | true  | true     |             0 |                      0 |                                                                   |
|   75 | node_modules/@rollup/rollup-openbsd-x64               | 4.62.3        | true  | true     |             0 |                      0 |                                                                   |
|   76 | node_modules/@rollup/rollup-openharmony-arm64         | 4.62.3        | true  | true     |             0 |                      0 |                                                                   |
|   77 | node_modules/@rollup/rollup-win32-arm64-msvc          | 4.62.3        | true  | true     |             0 |                      0 |                                                                   |
|   78 | node_modules/@rollup/rollup-win32-ia32-msvc           | 4.62.3        | true  | true     |             0 |                      0 |                                                                   |
|   79 | node_modules/@rollup/rollup-win32-x64-gnu             | 4.62.3        | true  | true     |             0 |                      0 |                                                                   |
|   80 | node_modules/@rollup/rollup-win32-x64-msvc            | 4.62.3        | true  | true     |             0 |                      0 |                                                                   |
|   81 | node_modules/@types/babel__core                       | 7.20.5        | true  | false    |             5 |                      0 |                                                                   |
|   82 | node_modules/@types/babel__generator                  | 7.27.0        | true  | false    |             1 |                      0 |                                                                   |
|   83 | node_modules/@types/babel__template                   | 7.4.4         | true  | false    |             2 |                      0 |                                                                   |
|   84 | node_modules/@types/babel__traverse                   | 7.28.0        | true  | false    |             1 |                      0 |                                                                   |
|   85 | node_modules/@types/estree                            | 1.0.9         | true  | false    |             0 |                      0 |                                                                   |
|   86 | node_modules/@types/node                              | 22.20.1       | true  | false    |             1 |                      0 |                                                                   |
|   87 | node_modules/@types/react                             | 19.2.17       | true  | false    |             1 |                      0 |                                                                   |
|   88 | node_modules/@types/react-dom                         | 19.2.3        | true  | false    |             0 |                      0 |                                                                   |
|   89 | node_modules/@vitejs/plugin-react                     | 4.7.0         | true  | false    |             6 |                      0 | ^14.18.0 \|\| >=16.0.0                                            |
|   90 | node_modules/accepts                                  | 2.0.0         | false | false    |             2 |                      0 | >= 0.6                                                            |
|   91 | node_modules/ajv                                      | 8.20.0        | false | false    |             4 |                      0 |                                                                   |
|   92 | node_modules/ajv-formats                              | 3.0.1         | false | false    |             1 |                      0 |                                                                   |
|   93 | node_modules/ansi-regex                               | 5.0.1         | true  | false    |             0 |                      0 | >=8                                                               |
|   94 | node_modules/ansi-styles                              | 4.3.0         | true  | false    |             1 |                      0 | >=8                                                               |
|   95 | node_modules/baseline-browser-mapping                 | 2.11.5        | true  | false    |             0 |                      0 | >=6.0.0                                                           |
|   96 | node_modules/body-parser                              | 2.3.0         | false | false    |             9 |                      0 | >=18                                                              |
|   97 | node_modules/body-parser/node_modules/content-type    | 2.0.0         | false | false    |             0 |                      0 | >=18                                                              |
|   98 | node_modules/browserslist                             | 4.28.7        | true  | false    |             5 |                      0 | ^6 \|\| ^7 \|\| ^8 \|\| ^9 \|\| ^10 \|\| ^11 \|\| ^12 \|\| >=13.7 |
|   99 | node_modules/busboy                                   | 1.6.0         | false | false    |             1 |                      0 | >=10.16.0                                                         |
|  100 | node_modules/bytes                                    | 3.1.2         | false | false    |             0 |                      0 | >= 0.8                                                            |
|  101 | node_modules/call-bind-apply-helpers                  | 1.0.2         | false | false    |             2 |                      0 | >= 0.4                                                            |
|  102 | node_modules/call-bound                               | 1.0.4         | false | false    |             2 |                      0 | >= 0.4                                                            |
|  103 | node_modules/caniuse-lite                             | 1.0.30001806  | true  | false    |             0 |                      0 |                                                                   |
|  104 | node_modules/chalk                                    | 4.1.2         | true  | false    |             2 |                      0 | >=10                                                              |
|  105 | node_modules/chalk/node_modules/supports-color        | 7.2.0         | true  | false    |             1 |                      0 | >=8                                                               |
|  106 | node_modules/cliui                                    | 8.0.1         | true  | false    |             3 |                      0 | >=12                                                              |
|  107 | node_modules/color-convert                            | 2.0.1         | true  | false    |             1 |                      0 | >=7.0.0                                                           |
|  108 | node_modules/color-name                               | 1.1.4         | true  | false    |             0 |                      0 |                                                                   |
|  109 | node_modules/concurrently                             | 9.2.4         | true  | false    |             6 |                      0 | >=18                                                              |
|  110 | node_modules/content-disposition                      | 1.1.0         | false | false    |             0 |                      0 | >=18                                                              |
|  111 | node_modules/content-type                             | 1.0.5         | false | false    |             0 |                      0 | >= 0.6                                                            |
|  112 | node_modules/convert-source-map                       | 2.0.0         | true  | false    |             0 |                      0 |                                                                   |
|  113 | node_modules/cookie                                   | 0.7.2         | false | false    |             0 |                      0 | >= 0.6                                                            |
|  114 | node_modules/cookie-signature                         | 1.2.2         | false | false    |             0 |                      0 | >=6.6.0                                                           |
|  115 | node_modules/cors                                     | 2.8.6         | false | false    |             2 |                      0 | >= 0.10                                                           |
|  116 | node_modules/cross-spawn                              | 7.0.6         | false | false    |             3 |                      0 | >= 8                                                              |
|  117 | node_modules/csstype                                  | 3.2.3         | true  | false    |             0 |                      0 |                                                                   |
|  118 | node_modules/debug                                    | 4.4.3         | false | false    |             1 |                      0 | >=6.0                                                             |
|  119 | node_modules/depd                                     | 2.0.0         | false | false    |             0 |                      0 | >= 0.8                                                            |
|  120 | node_modules/dunder-proto                             | 1.0.1         | false | false    |             3 |                      0 | >= 0.4                                                            |
|  121 | node_modules/ee-first                                 | 1.1.1         | false | false    |             0 |                      0 |                                                                   |
|  122 | node_modules/electron-to-chromium                     | 1.5.396       | true  | false    |             0 |                      0 |                                                                   |
|  123 | node_modules/emoji-regex                              | 8.0.0         | true  | false    |             0 |                      0 |                                                                   |
|  124 | node_modules/encodeurl                                | 2.0.0         | false | false    |             0 |                      0 | >= 0.8                                                            |
|  125 | node_modules/es-define-property                       | 1.0.1         | false | false    |             0 |                      0 | >= 0.4                                                            |
|  126 | node_modules/es-errors                                | 1.3.0         | false | false    |             0 |                      0 | >= 0.4                                                            |
|  127 | node_modules/es-object-atoms                          | 1.1.2         | false | false    |             1 |                      0 | >= 0.4                                                            |
|  128 | node_modules/esbuild                                  | 0.25.12       | true  | false    |             0 |                     26 | >=18                                                              |
|  129 | node_modules/escalade                                 | 3.2.0         | true  | false    |             0 |                      0 | >=6                                                               |
|  130 | node_modules/escape-html                              | 1.0.3         | false | false    |             0 |                      0 |                                                                   |
|  131 | node_modules/etag                                     | 1.8.1         | false | false    |             0 |                      0 | >= 0.6                                                            |
|  132 | node_modules/eventsource                              | 3.0.7         | false | false    |             1 |                      0 | >=18.0.0                                                          |
|  133 | node_modules/eventsource-parser                       | 3.1.0         | false | false    |             0 |                      0 | >=18.0.0                                                          |
|  134 | node_modules/express                                  | 5.2.1         | false | false    |            28 |                      0 | >= 18                                                             |
|  135 | node_modules/express-rate-limit                       | 8.6.2         | false | false    |             2 |                      0 | >= 16                                                             |
|  136 | node_modules/fast-deep-equal                          | 3.1.3         | false | false    |             0 |                      0 |                                                                   |
|  137 | node_modules/fast-uri                                 | 3.1.5         | false | false    |             0 |                      0 |                                                                   |
|  138 | node_modules/fdir                                     | 6.5.0         | true  | false    |             0 |                      0 | >=12.0.0                                                          |
|  139 | node_modules/finalhandler                             | 2.1.1         | false | false    |             6 |                      0 | >= 18.0.0                                                         |
|  140 | node_modules/forwarded                                | 0.2.0         | false | false    |             0 |                      0 | >= 0.6                                                            |
|  141 | node_modules/fresh                                    | 2.0.0         | false | false    |             0 |                      0 | >= 0.8                                                            |
|  142 | node_modules/fsevents                                 | 2.3.3         | true  | true     |             0 |                      0 | ^8.16.0 \|\| ^10.6.0 \|\| >=11.0.0                                |
|  143 | node_modules/function-bind                            | 1.1.2         | false | false    |             0 |                      0 |                                                                   |
|  144 | node_modules/gensync                                  | 1.0.0-beta.2  | true  | false    |             0 |                      0 | >=6.9.0                                                           |
|  145 | node_modules/get-caller-file                          | 2.0.5         | true  | false    |             0 |                      0 | 6.* \|\| 8.* \|\| >= 10.*                                         |
|  146 | node_modules/get-intrinsic                            | 1.3.0         | false | false    |            10 |                      0 | >= 0.4                                                            |
|  147 | node_modules/get-proto                                | 1.0.1         | false | false    |             2 |                      0 | >= 0.4                                                            |
|  148 | node_modules/gopd                                     | 1.2.0         | false | false    |             0 |                      0 | >= 0.4                                                            |
|  149 | node_modules/has-flag                                 | 4.0.0         | true  | false    |             0 |                      0 | >=8                                                               |
|  150 | node_modules/has-symbols                              | 1.1.0         | false | false    |             0 |                      0 | >= 0.4                                                            |
|  151 | node_modules/hasown                                   | 2.0.4         | false | false    |             1 |                      0 | >= 0.4                                                            |
|  152 | node_modules/hono                                     | 4.13.1        | false | false    |             0 |                      0 | >=16.9.0                                                          |
|  153 | node_modules/http-errors                              | 2.0.1         | false | false    |             5 |                      0 | >= 0.8                                                            |
|  154 | node_modules/iconv-lite                               | 0.7.3         | false | false    |             1 |                      0 | >=0.10.0                                                          |
|  155 | node_modules/inherits                                 | 2.0.4         | false | false    |             0 |                      0 |                                                                   |
|  156 | node_modules/ip-address                               | 10.4.0        | false | false    |             0 |                      0 | >= 12                                                             |
|  157 | node_modules/ipaddr.js                                | 1.9.1         | false | false    |             0 |                      0 | >= 0.10                                                           |
|  158 | node_modules/is-fullwidth-code-point                  | 3.0.0         | true  | false    |             0 |                      0 | >=8                                                               |
|  159 | node_modules/is-promise                               | 4.0.0         | false | false    |             0 |                      0 |                                                                   |
|  160 | node_modules/isexe                                    | 2.0.0         | false | false    |             0 |                      0 |                                                                   |
|  161 | node_modules/jose                                     | 6.2.8         | false | false    |             0 |                      0 |                                                                   |
|  162 | node_modules/js-tokens                                | 4.0.0         | true  | false    |             0 |                      0 |                                                                   |
|  163 | node_modules/jsesc                                    | 3.1.0         | true  | false    |             0 |                      0 | >=6                                                               |
|  164 | node_modules/json-schema-traverse                     | 1.0.0         | false | false    |             0 |                      0 |                                                                   |
|  165 | node_modules/json-schema-typed                        | 8.0.2         | false | false    |             0 |                      0 |                                                                   |
|  166 | node_modules/json5                                    | 2.2.3         | true  | false    |             0 |                      0 | >=6                                                               |
|  167 | node_modules/lru-cache                                | 5.1.1         | true  | false    |             1 |                      0 |                                                                   |
|  168 | node_modules/lucide-react                             | 0.468.0       | false | false    |             0 |                      0 |                                                                   |
|  169 | node_modules/math-intrinsics                          | 1.1.0         | false | false    |             0 |                      0 | >= 0.4                                                            |
|  170 | node_modules/media-typer                              | 1.1.1         | false | false    |             0 |                      0 | >= 0.8                                                            |
|  171 | node_modules/merge-descriptors                        | 2.0.0         | false | false    |             0 |                      0 | >=18                                                              |
|  172 | node_modules/mime-db                                  | 1.54.0        | false | false    |             0 |                      0 | >= 0.6                                                            |
|  173 | node_modules/mime-types                               | 3.0.2         | false | false    |             1 |                      0 | >=18                                                              |
|  174 | node_modules/ms                                       | 2.1.3         | false | false    |             0 |                      0 |                                                                   |
|  175 | node_modules/nanoid                                   | 3.3.18        | true  | false    |             0 |                      0 | ^10 \|\| ^12 \|\| ^13.7 \|\| ^14 \|\| >=15.0.1                    |
|  176 | node_modules/negotiator                               | 1.0.0         | false | false    |             0 |                      0 | >= 0.6                                                            |
|  177 | node_modules/node-releases                            | 2.0.51        | true  | false    |             0 |                      0 | >=18                                                              |
|  178 | node_modules/nodemailer                               | 9.0.3         | false | false    |             0 |                      0 | >=6.0.0                                                           |
|  179 | node_modules/object-assign                            | 4.1.1         | false | false    |             0 |                      0 | >=0.10.0                                                          |
|  180 | node_modules/object-inspect                           | 1.13.4        | false | false    |             0 |                      0 | >= 0.4                                                            |
|  181 | node_modules/on-finished                              | 2.4.1         | false | false    |             1 |                      0 | >= 0.8                                                            |
|  182 | node_modules/once                                     | 1.4.0         | false | false    |             1 |                      0 |                                                                   |
|  183 | node_modules/parseurl                                 | 1.3.3         | false | false    |             0 |                      0 | >= 0.8                                                            |
|  184 | node_modules/path-key                                 | 3.1.1         | false | false    |             0 |                      0 | >=8                                                               |
|  185 | node_modules/path-to-regexp                           | 8.4.2         | false | false    |             0 |                      0 |                                                                   |
|  186 | node_modules/picocolors                               | 1.1.1         | true  | false    |             0 |                      0 |                                                                   |
|  187 | node_modules/picomatch                                | 4.0.5         | true  | false    |             0 |                      0 | >=12                                                              |
|  188 | node_modules/pkce-challenge                           | 5.0.1         | false | false    |             0 |                      0 | >=16.20.0                                                         |
|  189 | node_modules/playwright                               | 1.55.1        | true  | false    |             1 |                      1 | >=18                                                              |
|  190 | node_modules/playwright-core                          | 1.55.1        | true  | false    |             0 |                      0 | >=18                                                              |
|  191 | node_modules/playwright/node_modules/fsevents         | 2.3.2         | true  | true     |             0 |                      0 | ^8.16.0 \|\| ^10.6.0 \|\| >=11.0.0                                |
|  192 | node_modules/postcss                                  | 8.5.23        | true  | false    |             3 |                      0 | ^10 \|\| ^12 \|\| >=14                                            |
|  193 | node_modules/proxy-addr                               | 2.0.7         | false | false    |             2 |                      0 | >= 0.10                                                           |
|  194 | node_modules/qs                                       | 6.15.3        | false | false    |             2 |                      0 | >=0.6                                                             |
|  195 | node_modules/range-parser                             | 1.3.0         | false | false    |             0 |                      0 | >= 0.6                                                            |
|  196 | node_modules/raw-body                                 | 3.0.2         | false | false    |             4 |                      0 | >= 0.10                                                           |
|  197 | node_modules/react                                    | 19.2.8        | false | false    |             0 |                      0 | >=0.10.0                                                          |
|  198 | node_modules/react-dom                                | 19.2.8        | false | false    |             1 |                      0 |                                                                   |
|  199 | node_modules/react-refresh                            | 0.17.0        | true  | false    |             0 |                      0 | >=0.10.0                                                          |
|  200 | node_modules/require-directory                        | 2.1.1         | true  | false    |             0 |                      0 | >=0.10.0                                                          |
|  201 | node_modules/require-from-string                      | 2.0.2         | false | false    |             0 |                      0 | >=0.10.0                                                          |
|  202 | node_modules/rollup                                   | 4.62.3        | true  | false    |             1 |                     26 | >=18.0.0                                                          |
|  203 | node_modules/router                                   | 2.2.0         | false | false    |             5 |                      0 | >= 18                                                             |
|  204 | node_modules/rxjs                                     | 7.8.2         | true  | false    |             1 |                      0 |                                                                   |
|  205 | node_modules/safer-buffer                             | 2.1.2         | false | false    |             0 |                      0 |                                                                   |
|  206 | node_modules/scheduler                                | 0.27.0        | false | false    |             0 |                      0 |                                                                   |
|  207 | node_modules/semver                                   | 6.3.1         | true  | false    |             0 |                      0 |                                                                   |
|  208 | node_modules/send                                     | 1.2.1         | false | false    |            11 |                      0 | >= 18                                                             |
|  209 | node_modules/serve-static                             | 2.2.1         | false | false    |             4 |                      0 | >= 18                                                             |
|  210 | node_modules/setprototypeof                           | 1.2.0         | false | false    |             0 |                      0 |                                                                   |
|  211 | node_modules/shebang-command                          | 2.0.0         | false | false    |             1 |                      0 | >=8                                                               |
|  212 | node_modules/shebang-regex                            | 3.0.0         | false | false    |             0 |                      0 | >=8                                                               |
|  213 | node_modules/shell-quote                              | 1.9.0         | true  | false    |             0 |                      0 | >= 0.4                                                            |
|  214 | node_modules/side-channel                             | 1.1.1         | false | false    |             5 |                      0 | >= 0.4                                                            |
|  215 | node_modules/side-channel-list                        | 1.0.1         | false | false    |             2 |                      0 | >= 0.4                                                            |
|  216 | node_modules/side-channel-map                         | 1.0.1         | false | false    |             4 |                      0 | >= 0.4                                                            |
|  217 | node_modules/side-channel-weakmap                     | 1.0.2         | false | false    |             5 |                      0 | >= 0.4                                                            |
|  218 | node_modules/source-map-js                            | 1.2.1         | true  | false    |             0 |                      0 | >=0.10.0                                                          |
|  219 | node_modules/statuses                                 | 2.0.2         | false | false    |             0 |                      0 | >= 0.8                                                            |
|  220 | node_modules/streamsearch                             | 1.1.0         | false | false    |             0 |                      0 | >=10.0.0                                                          |
|  221 | node_modules/string-width                             | 4.2.3         | true  | false    |             3 |                      0 | >=8                                                               |
|  222 | node_modules/strip-ansi                               | 6.0.1         | true  | false    |             1 |                      0 | >=8                                                               |
|  223 | node_modules/supports-color                           | 8.1.1         | true  | false    |             1 |                      0 | >=10                                                              |
|  224 | node_modules/tinyglobby                               | 0.2.17        | true  | false    |             2 |                      0 | >=12.0.0                                                          |
|  225 | node_modules/toidentifier                             | 1.0.1         | false | false    |             0 |                      0 | >=0.6                                                             |
|  226 | node_modules/tree-kill                                | 1.2.2         | true  | false    |             0 |                      0 |                                                                   |
|  227 | node_modules/tslib                                    | 2.8.1         | true  | false    |             0 |                      0 |                                                                   |
|  228 | node_modules/type-is                                  | 2.1.0         | false | false    |             3 |                      0 | >= 18                                                             |
|  229 | node_modules/type-is/node_modules/content-type        | 2.0.0         | false | false    |             0 |                      0 | >=18                                                              |
|  230 | node_modules/typescript                               | 5.7.3         | true  | false    |             0 |                      0 | >=14.17                                                           |
|  231 | node_modules/undici-types                             | 6.21.0        | true  | false    |             0 |                      0 |                                                                   |
|  232 | node_modules/unpipe                                   | 1.0.0         | false | false    |             0 |                      0 | >= 0.8                                                            |
|  233 | node_modules/update-browserslist-db                   | 1.2.3         | true  | false    |             2 |                      0 |                                                                   |
|  234 | node_modules/vary                                     | 1.1.2         | false | false    |             0 |                      0 | >= 0.8                                                            |
|  235 | node_modules/vite                                     | 6.4.3         | true  | false    |             6 |                      1 | ^18.0.0 \|\| ^20.0.0 \|\| >=22.0.0                                |
|  236 | node_modules/which                                    | 2.0.2         | false | false    |             1 |                      0 | >= 8                                                              |
|  237 | node_modules/wrap-ansi                                | 7.0.0         | true  | false    |             3 |                      0 | >=10                                                              |
|  238 | node_modules/wrappy                                   | 1.0.2         | false | false    |             0 |                      0 |                                                                   |
|  239 | node_modules/ws                                       | 8.21.3        | false | false    |             0 |                      0 | >=10.0.0                                                          |
|  240 | node_modules/y18n                                     | 5.0.8         | true  | false    |             0 |                      0 | >=10                                                              |
|  241 | node_modules/yallist                                  | 3.1.1         | true  | false    |             0 |                      0 |                                                                   |
|  242 | node_modules/yargs                                    | 17.7.2        | true  | false    |             7 |                      0 | >=12                                                              |
|  243 | node_modules/yargs-parser                             | 21.1.1        | true  | false    |             0 |                      0 | >=12                                                              |
|  244 | node_modules/zod                                      | 4.4.3         | false | false    |             0 |                      0 |                                                                   |
|  245 | node_modules/zod-to-json-schema                       | 3.25.2        | false | false    |             0 |                      0 |                                                                   |

## 解释边界

- lock 条目存在不表示运行时一定加载该包；dev/optional/平台条件会影响实际安装。
- npm audit 结果会随 advisory 数据库变化；历史 0 vulnerabilities 只能按 dated report 表述。
- 本轮没有执行 npm ci、pip install 或 dependency audit。
