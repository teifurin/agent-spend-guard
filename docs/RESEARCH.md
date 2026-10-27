# RESEARCH.md — PayPal AI Hackathon 资料来源笔记

整理时间：2026-10-27（JST）。标 ✅ 的是本次会话实际打开、读过的页面；标 ⚠️ 的是没有打开、按常识引用的页面，Claude 开工时要先核对。

## 1. 比赛本身

| 来源 | 要点 |
|---|---|
| ✅ https://paypalaihackathon.devpost.com/ | 截止 **2026-11-12 12:00 PST = 11-13 05:00 JST**。全球线上，日本可参加。没有赛道，唯一硬性要求是**真正用上 PayPal 和 AI**。必须有能跑起来的 demo（仓库里写清安装运行步骤，或给出托管 URL；设计稿或静态原型不算）。仓库要公开、开源，About 栏要能识别出 license。视频 <3 分钟，YouTube 公开，不能含第三方商标或有版权的音乐。要列出用到的 AI 工具，并说明怎么用的。赞助商工具可选：AG Grid、APIMatic、Astropods、Bryntum、Channel3、Elastic、KERNEL、Postman、Render、Zapier。 |
| ✅ https://paypalaihackathon.devpost.com/rules | 提交期 10/1 至 11/12 12:00 PT；评审 12/1 14:00 PT 至 12/15 08:00 PT（JST 12/2 07:00 至 12/16 01:00）；大约 12/21 14:00 PT（**JST 12/22 07:00**）公布获奖。第一阶段是 pass/fail，看是否切题、是否用了要求的 API。第二阶段五项权重相同：技术实现、设计、潜在影响、创新、展示；平分时按这个顺序比。一个项目最多拿 1 个大奖或荣誉奖，外加 1 个赞助奖。评审要能免费测试到评审期结束，测试账号、沙盒登录要写进 README。提交材料用英文。可能要填 W-8BEN，手续费和汇损自付。评审方式里可能包括"automated AI-driven analysis"。 |
| ✅ 同上（奖项） | 第一名 $12,000，第二名 $8,000，第三名 $5,000。Best Use of PayPal + AI $5,000。AG Grid 第 1/2/3 名 $5,000/$2,000/$1,000。APIMatic $1,000 加 6 个月订阅。Channel3 $1,500。Render 只给额度，不算现金。**概览页和规则页的奖项列表对不上**：概览页写有 "Most Impactful"、"Best Demo Delivery"、"Best Use of Agentic Commerce"，规则页写的是 "Most Creative $5,000"。规则第 11.4 条说**以规则为准**。 |
| ✅ https://paypalaihackathon.devpost.com/details/aggrid | AG Grid 奖的看点：**打磨程度**（自定义 widget、主题、布局工具，光放一个 AG Grid 或 AG Charts 不够），加上试用 **AG Studio 的 Studio Agent Framework**（自定义 agent 跟 Studio 内置 agent 对话，或者换上自己的 harness）。页面没写 AG Studio 的授权条款，⚠️ 要另外去 ag-grid.com 查清是否免费、能否开源分发。 |
| ✅ https://developer.paypal.com/community/blog/PayPal_AI_Hackathon/ (via search) | 各合作方的定位：AG Grid 主推 AG Studio（自助式仪表盘、AI assistant），Channel3 提供商品数据 API，Render 做部署。 |

## 2. PayPal 开发者平台（选型依据）

| 来源 | 要点 | 用在哪 |
|---|---|---|
| ✅ https://developer.paypal.com/ai-tools/toolkit | Agent Toolkit 支持 MCP、LangChain、OpenAI Agents SDK、Vercel AI SDK、Bedrock、CrewAI。官方最佳实践：先用 sandbox，密钥别写进代码，放环境变量里。 | 伸展目标：用策略中间件包住官方工具 |
| ✅ https://www.npmjs.com/package/@paypal/agent-toolkit | v1.11.0（2026-09），ISC 许可。`create_order` / `pay_order` / `create_refund` / `get_order` / `list_transactions` 等。可以通过 `configuration.actions` 限制开放哪些动作，但**只是开或关，没有金额、预算这类策略**，这正是本项目要补的空白。`create_order` 的参数里没有 vault_id。 | 说明"为什么需要护栏"；伸展目标 |
| ✅ https://developer.paypal.com/ai-tools/mcp-server | 官方 MCP：本地跑 `npx -y @paypal/mcp --tools=all`，配 `PAYPAL_ACCESS_TOKEN` 和 `PAYPAL_ENVIRONMENT=SANDBOX`；远程 sandbox 地址 `https://mcp.sandbox.paypal.com`。 | 背景、对比 |
| ✅ https://developer.paypal.com/ai-tools/agent-tools | 工具参考表。远程 MCP 另有 `search_product` / `create_cart` / `checkout_cart` 三个电商工具，**目前只卖礼品卡**，示例用的是 production 地址。 | 不用（不确定 sandbox 能不能用） |
| ✅ https://developer.paypal.com/agentic-commerce-services/about | Agentic commerce services（Store Sync、Agent Ready）要**填表申请开通**。 | 不用（评审没法免费复现） |
| ✅ https://developer.paypal.com/agent-ready/overview | Agent Ready：ACP（ChatGPT，走 Braintree 委托令牌）和 UCP（Google AI Mode / Gemini，走 Google Pay 加 Orders v2）。 | 只在 README 的 "Related work / future" 里提一下 |
| ✅ https://developer.paypal.com/store-sync/overview | 只支持美国、USD、实物商品，名额有限，要申请。 | 不用 |
| ✅ https://developer.paypal.com/api/payment-tokens/save-without-purchase/paypal | **Payment Method Tokens v3**：不用先付款就能保存 PayPal 钱包。买家批准一次 setup token，之后拿到 payment token；**扣款时买家不必在场**，用 Orders v2 加 `payment_source.paypal.vault_id` 创建订单并扣款。 | **主方案：主人一次性授权，相当于给 agent 发一张"授权书"** |
| ✅ https://developer.paypal.com/api/orders-v2/save-with-purchase/paypal | 也可以在第一次购买时顺带保存（`store_in_vault: ON_SUCCESS`，`usage_type: MERCHANT`）。买家在场的交易（CIT）用 payment token 时，PayPal 要求做 RDA（FraudNet/Magnes）；不做的话付款可能被拒。 | 备选；风险记录 |
| ✅ https://developer.paypal.com/docs/checkout/save-payment-methods/during-purchase/orders-api/paypal/ | Sandbox 开通方法：Developer Dashboard → 选 App → Sandbox App Settings → 勾选 Accept payments → Advanced options 里确认 **Vault** 已勾选。 | M0 准备工作 |
| ✅ PayPal Community / StackOverflow（via search） | 新建的 sandbox Business 账号默认开着 reference transactions；如果报 `NOT_ENABLED_FOR_VAULT` 之类的错，就新建一个 sandbox business 账号。 | M0 风险兜底 |
| ⚠️ https://developer.paypal.com/docs/api/orders/v2/ | Orders v2：`POST /v2/checkout/orders`、`POST /v2/checkout/orders/{id}/capture`、`GET`。`PayPal-Request-Id` 用来保证幂等。 | 扣款主路径 |
| ⚠️ https://developer.paypal.com/docs/api/payments/v2/ | `POST /v2/payments/captures/{id}/refund` | "撤销"按钮 |
| ⚠️ https://developer.paypal.com/docs/api/payment-tokens/v3/ | `POST /v3/vault/setup-tokens`、`POST /v3/vault/payment-tokens` | 授权书 |
| ⚠️ https://developer.paypal.com/api/rest/webhooks/ 和 https://developer.paypal.com/docs/api/webhooks/v1/ | 事件 `PAYMENT.CAPTURE.COMPLETED`、`PAYMENT.CAPTURE.REFUNDED`；验签用 `POST /v1/notifications/verify-webhook-signature`。需要公网 URL（本地开发用 tunnel）。 | 伸展目标：对账 |
| ⚠️ https://developer.paypal.com/tools/sandbox/accounts/ | Sandbox 会自动生成 personal 和 business 测试账号，登录信息在 Dashboard 里查看。 | README 里的评审复现步骤 |
| ⚠️ https://developer.paypal.com/api/rest/authentication/ | `POST /v1/oauth2/token`（client_credentials），sandbox token 有效期 3–8 小时，要做刷新。 | PayPal 客户端 |

## 3. 选型结论（为什么 PayPal 是核心，不是装饰）

1. **"授权书"本身就是 PayPal 对象**：主人用 sandbox 买家账号在 PayPal 页面上批准一次，护栏服务端拿到 payment token（vault）。agent 从头到尾**拿不到**任何 PayPal 凭证或令牌，只能向护栏"申请"。
2. **策略内的申请**由护栏用 Orders v2 + `vault_id` 在服务端创建订单并扣款，买家不必在场。
3. **超出策略的申请**会被挂起。主人在仪表盘批准后才扣款。Plan B / step-up：生成一个普通订单的 approve 链接，让主人亲自在 PayPal 结账页确认，**PayPal 自己就成了人工确认的那一环**。
4. **撤销**：Payments v2 refund。**对账**：GET order，伸展目标是 webhooks。
5. 跟官方 Agent Toolkit 比：官方的 `configuration.actions` 只能开关某个动作，没有金额、预算、商家、时间窗、异常检测和人工审批这些能力。这个空白就是创新点。

## 4. 未核实 / 风险

- 这个 sandbox app 能不能拿到 vault 的 payment token、用 `vault_id` 扣款会不会因为 RDA 被拒：**M0 先做 spike 验证**。走不通就切到 Plan B（每笔都给 approve 链接，策略内的也一样，由护栏自动打开或预先批准），或者用 sandbox 测试卡做 `payment_source.card`（⚠️ 要确认 sandbox 默认能不能处理卡支付）。
- AG Studio 的授权条款和免费额度没核实。AG Grid Community 是 MIT 许可，可以放心用。
- 概览页和规则页的奖项列表不一致，以规则为准。
