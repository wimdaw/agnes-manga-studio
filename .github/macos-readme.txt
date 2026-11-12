Agnes 漫剧工坊 · macOS

1. 把 AgnesStudio 拖到任意目录（建议 ~/Applications）。
2. 首次运行：右键点 AgnesStudio → 打开。
   若仍被拦截，在终端执行：
     xattr -cr /path/to/AgnesStudio
   然后重新运行。程序为 ad-hoc 签名，未做 Apple 公证。
3. 启动后会自动打开浏览器（http://127.0.0.1:5178）；
   没弹出就手动访问该地址。
4. 数据保存在 ~/Library/Application Support/AgnesStudio。
5. 需要 Agnes API Key：设置 → 密钥池，粘贴后即可生成内容。

命令行运行：./AgnesStudio
