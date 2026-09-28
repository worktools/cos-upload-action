# Tencent COS 上传 Action

将一个本地目录递归上传到腾讯云对象存储（COS）。这是一个范围刻意收窄的 GitHub composite Action：它只负责**校验输入、下载并核对 COSCLI、上传文件、报告错误**；不编译项目、不推断 CDN 地址、不发布网页，也不删除存储桶中的旧对象。

当前固定使用官方 COSCLI `v1.0.9`，支持 GitHub Actions 的 Linux/macOS x64 与 arm64 runner。各平台二进制均按发布清单中的 SHA-256 校验；不支持 Windows runner。

## 使用示例

以下示例让 PR 使用独立的 `/pr/` 前缀。构建、CDN base URL、远端可读性检查和其他部署方式均由调用项目自行安排：

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
        uses: worktools/cos-upload-action@v1.0.0
        with:
          source-dir: dist
          bucket: ${{ secrets.COS_BUCKET }}
          region: ap-shanghai
          prefix: ${{ github.repository }}/pr/
          secret-id: ${{ secrets.COS_SECRET_ID }}
          secret-key: ${{ secrets.COS_SECRET_KEY }}
      - name: Verify public CDN assets
        run: node scripts/verify-cdn-build.mjs --remote
```

生产流程应把 `prefix` 改为 `${{ github.repository }}/`，并在上传成功且 CDN 验证通过之后再发布会引用这些资源的 HTML。实际使用时，建议把 `@v1.0.0` 固定成已审阅的完整提交 SHA。对于来自 fork 的 PR，GitHub 不提供这些 secrets，因此应像示例一样跳过上传，不要改用 `pull_request_target` 执行不可信代码。

## 输入参数

| 参数 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `source-dir` | 是 | — | 要递归上传的本地目录；必须存在且包含普通文件，不允许是 checkout 根目录或 `/`。 |
| `bucket` | 是 | — | 完整 COS 存储桶名，包含 APPID。 |
| `prefix` | 是 | — | 对象键前缀；非空、相对路径，末尾 `/` 可省略。为防止意外上传到根目录，不支持空前缀。 |
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
| `forbid-overwrite` | 否 | `false` | 为 `true` 时禁止覆盖同名对象；常规重复部署应保持 `false`。 |

输出 `destination` 是 `cos://<bucket>/<prefix>/`。本 Action 使用 `cp` 而不是 `sync`，不会删除已存在但本次没有上传的对象；过滤规则由 COSCLI 按源路径匹配，调用前应先核对实际文件列表。

## 错误与验证

Action 在以下情况会立即失败：必填参数缺失、源目录不存在或为空、路径/数值不合法、runner 平台不支持、COSCLI 下载或 SHA-256 校验失败、COSCLI 报告任何上传失败。错误摘要会显示 COS 返回的错误码，但不会打印密钥或完整请求日志。

- `AccessDenied`：检查桶及目标前缀的上传、覆盖和分片上传权限。
- `SignatureDoesNotMatch` / `InvalidAccessKeyId`：检查 SecretId、SecretKey、临时 token 和地域。
- `NoSuchBucket`：检查包含 APPID 的桶名和地域。

本仓库的 `scripts/test.sh` 验证参数校验和明确报错；CI 还用一个预期失败的本地 Action 调用确认 metadata 与错误传播。**上传成功不等于 CDN 已可读**：调用项目仍应检查生成 HTML 的资源 URL，并在上传后从自己的公开域名读取资源。首次真实集成以 `calcit-lang/respo-calcit-workflow` 的 PR 构建为验收样例。

本 Action 不创建公开读权限，也不执行删除。建议使用限定 bucket 与 prefix 的最小权限凭据；如可行，优先使用临时密钥。[COSCLI 通用选项](https://intl.cloud.tencent.com/zh/document/product/436/46273)和[上传命令说明](https://cloud.tencent.com/document/product/436/63669)可用于核对权限与参数语义。
