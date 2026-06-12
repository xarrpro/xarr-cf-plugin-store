#!/usr/bin/env bash
#
# CF Plugin Store 一键部署辅助脚本
#
# 前提:你已经在网页注册了 Cloudflare 账号,并在 Dashboard 启用了 R2。
# 用法:先 `npx wrangler login` 登录,然后在本目录运行 `bash deploy.sh`
#
# 脚本会:创建 D1/KV/R2 → 自动把 id 填进 wrangler.toml → 设网关密钥
#         → 远程建表 → 部署 → 引导你写第一个管理员令牌 → curl 验证
# 每一步都会打印它在做什么;任何一步失败会停下并提示。

set -uo pipefail
cd "$(dirname "$0")"

say() { printf "\n\033[1;36m==> %s\033[0m\n" "$1"; }
die() { printf "\n\033[1;31m[错误] %s\033[0m\n" "$1"; exit 1; }

# ---------- 0. 检查登录 ----------
say "检查 Cloudflare 登录状态"
if ! npx wrangler whoami 2>/dev/null | grep -qi "account"; then
  die "尚未登录。请先运行: npx wrangler login"
fi

# ---------- 1. 创建 D1 ----------
say "创建 D1 数据库 plugin_store(若已存在将复用已有 id)"
D1_OUT=$(npx wrangler d1 create plugin_store 2>&1 || true)
echo "$D1_OUT"
# 从输出里提取 36 位 uuid 形式的 database_id
D1_ID=$(printf "%s" "$D1_OUT" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)
if [ -z "$D1_ID" ]; then
  echo "未能自动识别 database_id。请在上面输出里找到 database_id 的值,手动填入 wrangler.toml 第12行。"
  read -r -p "请粘贴 database_id(没有则直接回车跳过自动填充): " D1_ID
fi
[ -n "$D1_ID" ] && echo "database_id = $D1_ID"

# ---------- 2. 创建 KV ----------
say "创建 KV namespace KV"
KV_OUT=$(npx wrangler kv namespace create KV 2>&1 || true)
echo "$KV_OUT"
# KV id 通常是 32 位 hex
KV_ID=$(printf "%s" "$KV_OUT" | grep -oE '[0-9a-f]{32}' | head -1)
if [ -z "$KV_ID" ]; then
  read -r -p "请粘贴 KV id(没有则回车跳过): " KV_ID
fi
[ -n "$KV_ID" ] && echo "kv id = $KV_ID"

# ---------- 3. 创建 R2 ----------
say "创建 R2 存储桶 plugin-store-packages"
npx wrangler r2 bucket create plugin-store-packages 2>&1 || \
  echo "(R2 创建失败或已存在。若提示未启用 R2,请去 Dashboard 左侧 R2 启用后重跑)"

# ---------- 4. 回填 wrangler.toml ----------
say "把 id 写入 wrangler.toml"
if [ -n "$D1_ID" ]; then
  sed -i.bak "s|database_id = \"PLACEHOLDER_RUN_wrangler_d1_create\"|database_id = \"$D1_ID\"|" wrangler.toml
fi
if [ -n "$KV_ID" ]; then
  sed -i.bak "s|id = \"PLACEHOLDER_RUN_wrangler_kv_namespace_create\"|id = \"$KV_ID\"|" wrangler.toml
fi
rm -f wrangler.toml.bak

# 设网关秘密入口
if grep -q 'change-me-initial-gateway-uuid' wrangler.toml; then
  GW=$(node -e "console.log(require('crypto').randomUUID()+'-'+require('crypto').randomUUID())")
  sed -i.bak "s|change-me-initial-gateway-uuid|$GW|" wrangler.toml && rm -f wrangler.toml.bak
  echo "已生成网关秘密入口 GATEWAY_UUID_SEED = $GW"
  echo ">>> 请记下这个值,发布插件时要用作 XPLUGIN_GATEWAY_UUID <<<"
else
  GW=$(grep GATEWAY_UUID_SEED wrangler.toml | sed -E 's/.*"(.*)".*/\1/')
  echo "网关已设置为: $GW"
fi

echo ""
echo "当前 wrangler.toml 关键行:"
grep -nE "database_id|^id =|GATEWAY_UUID_SEED" wrangler.toml

# ---------- 5. 远程建表 ----------
say "远程 D1 建表(migrations)"
npx wrangler d1 migrations apply plugin_store --remote || die "建表失败"

# ---------- 6. 部署 ----------
say "部署 Worker"
DEPLOY_OUT=$(npx wrangler deploy 2>&1)
echo "$DEPLOY_OUT"
URL=$(printf "%s" "$DEPLOY_OUT" | grep -oE 'https://[^ ]+\.workers\.dev' | head -1)
[ -z "$URL" ] && URL="(请在上面输出里找到你的 https://....workers.dev 地址)"
echo "线上地址: $URL"

# ---------- 7. 写第一个管理员令牌 ----------
say "创建第一个管理员令牌"
read -r -p "给自己定一个管理员明文令牌(自己记住,如 my-secret-2026): " TOKEN
[ -z "$TOKEN" ] && die "令牌不能为空"
HASH=$(node -e "process.stdout.write(require('crypto').createHash('sha256').update(process.argv[1]).digest('hex'))" "$TOKEN")
npx wrangler kv key put --remote --binding KV "token:tok_root" \
  "{\"name\":\"root\",\"hash\":\"$HASH\",\"scope\":\"admin\",\"createdAt\":0,\"expireAt\":0,\"revoked\":false}" \
  || die "写令牌失败"
echo "管理员令牌已写入。明文请妥善保管: $TOKEN"

# ---------- 8. 验证 ----------
say "验证公开接口"
if [ "${URL:0:5}" = "https" ]; then
  echo "GET $URL/api/plugins"
  curl -s "$URL/api/plugins"; echo ""
fi

say "完成!"
echo "线上地址 : $URL"
echo "网关入口 : $GW"
echo "管理令牌 : $TOKEN"
echo ""
echo "用 CLI 发布插件:"
echo "  export XPLUGIN_BASE_URL=$URL"
echo "  export XPLUGIN_GATEWAY_UUID=$GW"
echo "  export XPLUGIN_TOKEN=$TOKEN"
echo "  node cli/bin/xplugin.mjs init my-plugin && cd my-plugin && node ../cli/bin/xplugin.mjs publish"
