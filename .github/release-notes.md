## 下载

| 平台 | 文件 | 说明 |
|---|---|---|
| Windows x64 | `AgnesStudio-windows-x64.exe` | 单文件，双击运行 |
| macOS Apple Silicon | `AgnesStudio-macos-arm64.zip` | 解压后右键「打开」 |
| macOS Intel | `AgnesStudio-macos-x64.zip` | 解压后右键「打开」 |

无需安装 Node.js —— 运行时已经打进可执行文件。

## 首次使用

1. 启动后会自动打开浏览器（`http://127.0.0.1:5178`），没弹出就手动访问。
2. 进入「设置 → 密钥池」，粘贴 Agnes API Key（可放多把自动轮换）。
3. 新建项目 → 生成脚本 → 分镜 → 出图 → 出视频 → 剪辑台。

## 数据位置

- Windows：exe 同级 `data/`（便携）；删除 `portable` 标记后改用 `%LOCALAPPDATA%\AgnesStudio`。
- macOS：`~/Library/Application Support/AgnesStudio`。

密钥、项目、素材都只存在本机，不会上传。

## 安全提示

- Windows 未做代码签名，SmartScreen 提示时选「更多信息 → 仍要运行」。
- macOS 为 ad-hoc 签名、未做 Apple 公证；首次打开请右键 → 打开，或在终端执行 `xattr -cr <路径>`。
- 校验文件完整性：同目录的 `SHA256SUMS.txt`。
