# Tencent COS 上传 Action

将一个本地目录递归上传到腾讯云对象存储（COS），并可立即从公开 CDN 逐文件校验上传结果。这是一个范围刻意收窄的 GitHub composite Action：它负责**校验输入、下载并核对 COSCLI、上传文件、通过公开 URL 核对字节数与 SHA-256、报告错误**；不编译项目、不推断 CDN 地址、不发布网页，也不删除存储桶中的旧对象。

当前固定使用官方 COSCLI `v1.0.9`，支持 GitHub Actions 的 Linux/macOS x64 与 arm64 runner。各平台二进制均按发布清单中的 SHA-256 校验；不支持 Windows runner。

## 使用示例

以下示例让 PR 使用独立的 `/pr/` 前缀。调用项目负责构建并让产物引用相同的 CDN base URL；Action 在上传后直接验证整个 `dist` 目录，不需要项目复制验证脚本：

```yaml
name: Upload PR preview
on: pull_request

permissions:
  contents: read

jobs:
  preview:
    if: github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v6
      - name: Build
        run: yarn build
      - name: Upload static files to COS
        uses: worktools/cos-upload-action@v1.1.0
        with:
          source-dir: dist
          bucket: ${{ secrets.COS_BUCKET }}
          region: ap-shanghai
          prefix: ${{ github.repository }}/pr/
          public-base-url: https://cos-sh.tiye.me/${{ github.repository }}/pr/
          secret-id: ${{ secrets.COS_SECRET_ID }}
          secret-key: ${{ secrets.COS_SECRET_KEY }}
```

生产流程应把 `prefix` 和 `public-base-url` 同时改为 `${{ github.repository }}/` 对应路径，并在 Action 成功之后再执行其他部署。实际使用时，建议把 `@v1.1.0` 固定成已审阅的完整提交 SHA。对于来自 fork 的 PR，GitHub 不提供这些 secrets，因此应像示例一样跳过上传，不要改用 `pull_request_target` 执行不可信代码。

## 输入参数

| 参数 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `source-dir` | 是 | — | 要递归上传的本地目录；必须存在且包含普通文件，不允许是 checkout 根目录或 `/`。 |
| `bucket` | 是 | — | 完整 COS 存储桶名，包含 APPID。 |
| `prefix` | 是 | — | 对象键前缀；非空、相对路径，末尾 `/` 可省略。为防止意外上传到根目录，不支持空前缀。 |
| `public-base-url` | 否 | 空 | 与 `prefix` 一一对应的公开 HTTPS URL。设置后自动读取源目录的每个普通文件，经 CDN 下载并核对字节数及 SHA-256；末尾 `/` 可省略。 |
| `region` | 否 | `ap-shanghai` | 存储桶地域，用于生成默认 endpoint。 |
| `endpoint` | 否 | `cos.<region>.myqcloud.com` | 仅允许腾讯云 COS 的标准或内网 hostname，不含协议或路径。 |
| `secret-id` / `secret-key` | 是 | — | COS 访问密钥；从 GitHub Secrets 传入。 |
| `session-token` | 否 | 空 | 使用临时密钥时的会话 token。 |
| `include` / `exclude` | 否 | 空 | COSCLI 的正则表达式过滤规则。 |
| `storage-class` | 否 | COS 默认 | 存储类型，直接传给 COSCLI。 |
| `metadata` | 否 | 空 | 对象元数据，例如 `Cache-Control:public,max-age=3600`。同一次调用对所有文件生效。 |
| `routines` | 否 | `3` | 并发文件数，范围 1–32。 |
| `thread-num` | 否 | `5` | 每个分片任务的线程数，范围 1–32。 |
| `part-size` | 否 | `32` | 分片大小，单位 MiB，范围 1–5120。 |
| `retry-count` | 否 | `5` | COSCLI 文件错误重试次数，范围 0–100。 |
| `verify-attempts` | 否 | `6` | 每个文件的公网验证次数，范围 1–20，用于等待 CDN 传播。 |
| `verify-delay-seconds` | 否 | `2` | 两次公网验证之间的等待秒数，范围 0–60。 |
| `verify-timeout-seconds` | 否 | `20` | 每次公网请求的超时秒数，范围 1–300。 |
| `forbid-overwrite` | 否 | `false` | 为 `true` 时禁止覆盖同名对象；常规重复部署应保持 `false`。 |

输出 `destination` 是 `cos://<bucket>/<prefix>/`；`public-base-url` 是规范化后的验证 URL，未启用时为空；`verified-files` 是成功核验的文件数，未启用时为 `0`。本 Action 使用 `cp` 而不是 `sync`，不会删除已存在但本次没有上传的对象；过滤规则由 COSCLI 按源路径匹配，调用前应先核对实际文件列表。

## 错误与验证

Action 会裁剪 bucket 与凭据输入首尾因复制产生的空白或换行，但仍拒绝凭据中间出现空白。Action 在以下情况会立即失败：必填参数缺失、源目录不存在或为空、路径/数值不合法、runner 平台不支持、COSCLI 下载或 SHA-256 校验失败、COSCLI 报告任何上传失败。错误摘要会显示 COS 返回的错误码，但不会打印密钥或完整请求日志。

- `AccessDenied`：检查桶及目标前缀的上传、覆盖和分片上传权限。
- `SignatureDoesNotMatch` / `InvalidAccessKeyId`：检查 SecretId、SecretKey、临时 token 和地域。
- `NoSuchBucket`：检查包含 APPID 的桶名和地域。

设置 `public-base-url` 后，Action 会枚举 `source-dir` 中的所有普通文件，以带缓存穿透参数的 URL 并发读取。只有 HTTP 成功、响应字节数和 SHA-256 都与本地文件一致才算通过；404、旧缓存、截断响应和内容不一致都会按配置重试，最终仍不一致则整个 Action 失败。请求显式使用 `Accept-Encoding: identity`，避免传输压缩干扰内容核对。

公网验证需要确认整个源目录，因此当前不能与 `include` / `exclude` 过滤同时使用；Action 会在上传前明确失败。需要筛选文件时，应先生成一个只包含待上传文件的专用目录，再将它作为 `source-dir`。

本仓库的 `scripts/test.sh` 验证参数校验和明确报错，`scripts/verify.test.mjs` 覆盖 URL 安全、嵌套路径编码、传播重试和旧内容拒绝；CI 还用一个预期失败的本地 Action 调用确认错误传播。首次真实集成以 `calcit-lang/respo-calcit-workflow` 的 PR 构建为验收样例。

本 Action 不创建公开读权限，也不执行删除。建议使用限定 bucket 与 prefix 的最小权限凭据；如可行，优先使用临时密钥。[COSCLI 通用选项](https://intl.cloud.tencent.com/zh/document/product/436/46273)和[上传命令说明](https://cloud.tencent.com/document/product/436/63669)可用于核对权限与参数语义。
