# Repo Constellation Web

GitHub Stars 知识库的独立 React 前端。它提供项目分页浏览、全文搜索、分类/语言/活跃度/排序筛选、最近更新和项目详情。`Agent 搜索` 是未来深度搜索的独立入口；在后端协议落地前会明确显示不可用，不会模拟 SSE。

## 本地开发

要求 Node.js 22+：

```bash
cd services/web
npm ci
npm run dev
```

Vite 从仓库根目录 `.env` 读取配置。开发时可将 `VITE_API_BASE_URL` 指向 Platform API，
例如 `http://localhost:8080`；该变量留空时前端请求当前 origin。

容器默认采用同源模式：Nginx 将 `/api/` 代理到 Docker 网络中的 `http://api:8080`，不需要浏览器跨域配置。生产部署需确保 Web 容器可以用服务名 `api` 访问 Platform API。

`VITE_API_BASE_URL` 是 Vite 构建时变量。如果 API 使用外部地址，可以通过 build arg 写入完整 URL；此时外部 API 需要允许 Web origin 的 CORS 请求。

## 质量检查

```bash
npm run lint
npm test
npm run build
```

## 容器

```bash
docker build -t repo-constellation-web:local services/web
docker run --rm -p 3000:8080 repo-constellation-web:local
```

以上容器需要加入能够解析 `api` 服务名的应用网络。前端使用 history 路由，镜像中的 Nginx 会将非 API 的未知路径回退至 `index.html`。

需要直接访问外部 API 时：

```bash
docker build \
  --build-arg VITE_API_BASE_URL=https://stars-api.example.com \
  -t repo-constellation-web:external services/web
```
