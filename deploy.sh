#!/usr/bin/env bash
#
# CF Plugin Store 一键部署脚本（secret 版）
#
# 前提：已注册 Cloudflare 账号并在 Dashboard 启用 R2；已在本目录 `npm install`。
# 用法：先 `./node_modules/.bin/wrangler login` 登录，然后运行 `bash deploy.sh`
#
# 流程：登录检查 → 创建 D1/KV/R2 → 由 wrangler.toml.example 生成 wrangler.toml 并注入资源 ID
#       → （可选）首次建表 → 部署 Worker → 设三个 Cloudflare Secret → 验证
# 机密（ADMIN_TOKEN / ADMIN_PATH / GATEWAY_UUID_SEED）用 wrangler secret 加密存储，不写入任何文件。

set -uo pipefail
cd "$(dirname "$0")"

say() { printf "\n\033[1;36m==> %s\033[0m\n" "$1"; }
die() { printf "\n\033[1;31m[错误] %s\033[0m\n" "$1"; exit 1; }
lc()  { printf "%s" "$1" | tr '[:upper:]' '[:lower:]'; }   # bash 3.2 兼容的小写转换

WRANGLER="./node_modules/.bin/wrangler"
CFG="--config ./wrangler.toml"
[ -x "$WRANGLER" ] || die "未找到 $WRANGLER，请先运行: npm install"

# ---------- 0. 登录检查 + 取 account_id ----------
say "检查 Cloudflare 登录状态"
WHO=$($WRANGLER whoami 2>/dev/null || true)
printf "%s" "$WHO" | grep -qi "account" || die "尚未登录。请先运行: $WRANGLER login"
ACCOUNT_ID=$(printf "%s" "$WHO" | grep -oE '[0-9a-f]{32}' | head -1)
[ -n "$ACCOUNT_ID" ] || read -r -p "请粘贴你的 Cloudflare account_id: " ACCOUNT_ID
[ -n "$ACCOUNT_ID" ] || die "account_id 不能为空"

# ---------- 1. 创建 D1 ----------
say "创建 D1 数据库 plugin_store（已存在则复用）"
D1_OUT=$($WRANGLER d1 create plugin_store 2>&1 || true); echo "$D1_OUT"
D1_ID=$(printf "%s" "$D1_OUT" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)
[ -n "$D1_ID" ] || read -r -p "请粘贴 database_id: " D1_ID
[ -n "$D1_ID" ] || die "database_id 不能为空"

# ---------- 2. 创建 KV ----------
say "创建 KV namespace KV（已存在则复用）"
KV_OUT=$($WRANGLER kv namespace create KV 2>&1 || true); echo "$KV_OUT"
KV_ID=$(printf "%s" "$KV_OUT" | grep -oE '[0-9a-f]{32}' | head -1)
[ -n "$KV_ID" ] || read -r -p "请粘贴 KV id: " KV_ID
[ -n "$KV_ID" ] || die "KV id 不能为空"

# ---------- 3. 创建 R2 ----------
say "创建 R2 存储桶 plugin-store-packages"
$WRANGLER r2 bucket create plugin-store-packages 2>&1 || \
  echo "(已存在或 R2 未启用；若未启用请去 Dashboard 左侧 R2 启用后重跑)"

# ---------- 4. 生成 wrangler.toml ----------
say "由 wrangler.toml.example 生成 wrangler.toml 并注入资源 ID"
[ -f wrangler.toml.example ] || die "缺少 wrangler.toml.example"
cp wrangler.toml.example wrangler.toml
sed -i.bak \
  -e "s|<your-cloudflare-account-id>|$ACCOUNT_ID|g" \
  -e "s|<your-d1-database-id>|$D1_ID|g" \
  -e "s|<your-kv-namespace-id>|$KV_ID|g" \
  wrangler.toml
rm -f wrangler.toml.bak
grep -q "<your-" wrangler.toml && die "wrangler.toml 仍有未替换占位符，请检查上面各步获取的 ID"
echo "wrangler.toml 关键行："; grep -nE "account_id|database_id|^id =" wrangler.toml

# ---------- 5. 首次建表（可选） ----------
say "远程 D1 建表（仅全新数据库需要）"
read -r -p "这是全新数据库、需要建表吗？已有自定义表结构的库请选 N。(y/N): " DO_MIG
if [ "$(lc "$DO_MIG")" = "y" ]; then
  $WRANGLER d1 migrations apply plugin_store --remote $CFG || die "建表失败"
else
  echo "已跳过建表。"
fi

# ---------- 6. 部署（先部署创建 Worker，之后才能设 secret） ----------
say "部署 Worker"
DEPLOY_OUT=$($WRANGLER deploy $CFG 2>&1); echo "$DEPLOY_OUT"
printf "%s" "$DEPLOY_OUT" | grep -qiE "Deployed|Current Version ID" || die "部署失败，请检查上面输出"
URL=$(printf "%s" "$DEPLOY_OUT" | grep -oE 'https://[^ ]+\.workers\.dev' | head -1)

# ---------- 7. 设三个 Cloudflare Secret ----------
say "设置机密（加密存储，不写入任何文件）"
read -r -p "管理员主令牌 ADMIN_TOKEN（留空则自动生成）: " ADMIN_TOKEN
[ -n "$ADMIN_TOKEN" ] || ADMIN_TOKEN=$(node -e "process.stdout.write(require('crypto').randomBytes(24).toString('hex'))")
read -r -p "后台密路径 ADMIN_PATH（留空则自动生成 console-xxxx）: " ADMIN_PATH
[ -n "$ADMIN_PATH" ] || ADMIN_PATH="console-$(node -e "process.stdout.write(require('crypto').randomBytes(8).toString('hex'))")"
GATEWAY_UUID_SEED=$(node -e "process.stdout.write(require('crypto').randomUUID()+require('crypto').randomUUID().replace(/-/g,''))")

printf '%s' "$ADMIN_TOKEN"       | $WRANGLER secret put ADMIN_TOKEN $CFG       || die "设 ADMIN_TOKEN 失败"
printf '%s' "$ADMIN_PATH"        | $WRANGLER secret put ADMIN_PATH $CFG        || die "设 ADMIN_PATH 失败"
printf '%s' "$GATEWAY_UUID_SEED" | $WRANGLER secret put GATEWAY_UUID_SEED $CFG || die "设 GATEWAY_UUID_SEED 失败"

# ---------- 8. 验证 ----------
say "验证公开接口"
if [ -n "$URL" ]; then echo "GET $URL/api/plugins"; curl -s "$URL/api/plugins"; echo ""; fi

say "完成！请妥善保管以下信息（令牌为 secret，无法再从配置查阅）："
echo "线上地址     : ${URL:-(见上方部署输出)}"
echo "后台入口     : ${URL:-<你的URL>}/$ADMIN_PATH"
echo "管理员令牌   : $ADMIN_TOKEN"
echo "默认下载入口 : $GATEWAY_UUID_SEED"
echo ""
echo "进入后台：浏览器打开「后台入口」地址，用「管理员令牌」登录。"
echo "下载入口在后台「下载入口」里签发/吊销（首次启动会把 GATEWAY_UUID_SEED 迁移为默认入口）。"
