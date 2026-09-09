# Web 字体可重复构建

网页预览使用由仓库内原始字体生成的 WOFF2 分片；Renderer 导出继续使用原始 OTF/TTF，不经过本生成流程。

全新 clone 后，在 `app/` 目录执行：

```powershell
python -m venv .font-tools
.\.font-tools\Scripts\python.exe -m pip install -r requirements-web-fonts.txt
.\.font-tools\Scripts\Activate.ps1
npm ci
npm run build:web-fonts
npm run build
```

Linux/macOS 激活虚拟环境时使用：

```bash
source .font-tools/bin/activate
```

生成结果位于 `public/fonts/web/` 和 `src/web-fonts.css`，不提交 Git。`npm run build` 会先检查 manifest、字体分片、文件大小、CSS 引用和许可证是否完整；缺失时直接失败并提示先运行 `npm run build:web-fonts`。

固定生成依赖见 `requirements-web-fonts.txt`。升级 Python、fonttools 或 brotli 时必须重新进行网页与 Renderer 的像素、换行和缓存验证，不能直接覆盖当前已验证版本。
