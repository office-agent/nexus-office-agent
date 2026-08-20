# 14 自建 PWA、设备与通知平台

## 1. 客户端定位

M8 首个自建客户端采用可安装 PWA，同时覆盖受支持的桌面与移动浏览器。网页继续承担管理后台，安装后客户端强调统一通知、快捷入口、设备可见性、离线状态和明确选择的草稿。它复用 `/api/v1` BFF、OIDC 会话、领域服务、权限和审计，不复制业务事实，也不直接持有数据库、模型或协作平台 Secret。

PWA 不等同于硬件证明。浏览器自报安装只能登记为 `unmanaged`；只有后续 MDM/设备证明适配器验证成功才可提升为 `managed`/`attested`。企业策略要求受管设备时，未验证设备可以使用允许的在线只读能力，但不得启用离线草稿或敏感通知。

## 2. 客户端契约

- `GET /api/v1/client/bootstrap`：返回当前身份的非敏感客户端策略、最低版本、功能开关、导航快捷入口和已登记设备状态。
- `GET/POST /api/v1/client/devices`：列出本人设备、登记当前安装。客户端只提交安装 UUID、显示名、客户端形态、平台和版本，不能自行指定 tenant/user/trust/status。
- `POST /api/v1/client/devices/:id/revoke`：本人撤销自己的设备；管理员撤销他人设备需要独立权限。
- `POST/DELETE /api/v1/client/devices/:id/push-subscription`：绑定或删除 Web Push 能力。订阅 endpoint 与密钥在服务端加密后持久化，响应不回显。

所有接口从签名会话解析租户和用户，写操作经过权限、对象归属和版本检查。设备 ID 只是定位符，不是认证凭据。

## 3. Service Worker 安全边界

- `/api/`、认证、ready/health 和任何业务导航均 network-only；不得把 JSON、HTML 业务页或响应头 Cookie 放入 Cache Storage。
- 只缓存版本化 `/_next/static/` 资源、图标、manifest 和无业务信息的 `offline.html`。
- 页面导航优先网络，断网只返回通用离线页，不返回上次查看的业务内容。
- Push payload 只接受相对路径；通知正文固定为通用提示，敏感标题、人员、金额、客户和审批结果不进入系统通知中心。

## 4. 安全离线草稿

离线草稿默认关闭，只允许 `Internal`，禁止 `Confidential` 与 `Restricted`。用户明确启用后，浏览器生成不可导出的 AES-GCM `CryptoKey` 并与密文一起存入 IndexedDB；标题和正文不以明文索引，草稿最长保留 7 天。清除站点数据、设备撤销或用户关闭功能时删除本地密钥和草稿。

设备密钥降低本地存储直接读取风险，但不能替代操作系统磁盘加密、锁屏和 MDM。共享设备、越狱/root 设备或企业策略要求受管设备时必须禁用离线草稿。草稿不会自动同步或自动触发 Agent/工作流；恢复在线后由用户检查并主动提交到具体业务表单。

## 5. 推送与快捷操作

通知权限只能由用户手势触发。服务端仅为 active 设备保存订阅；生产通过 `CLIENT_DATA_ENCRYPTION_KEY_REF` 从受管 Secret broker 解析 32 字节数据密钥并以 AES-256-GCM 加密订阅。密钥轮换采用新写入使用新版本、后台重加密旧记录、验证后撤旧。

manifest 提供今日工作台、项目、审批和收件箱快捷入口。深链在服务端重新鉴权，不因来自系统通知或桌面图标而绕过权限与 R3 确认。

## 6. 发布 Gate

- manifest、192/512 图标、Service Worker 和离线页可安装且作用域正确。
- 桌面与 390×844 移动端登记/撤销设备、离线/重连、通知权限拒绝均可恢复。
- Cache Storage 中不存在 `/api/`、HTML 业务页或包含用户数据的响应。
- IndexedDB 中草稿正文不可明文搜索，过期清理和“清除本地数据”生效。
- 篡改 tenant/user/trust/status、跨用户设备访问、已撤销设备推送全部拒绝。
- 生产就绪门禁要求数据加密密钥引用、最低客户端版本和设备策略显式配置。
- Web 容器必须同时携带 `public/` 中的 Service Worker、离线页和图标，并以非 root 用户运行；镜像验收逐项请求 manifest、`sw.js` 与 `offline.html`。
