"use client";

// 云服务统一部署（三合一）：备份桶 / 微信接入 / 离线推送在此一站配置。
// 新增「手动连接已有项目」入口，支持其他端直接填写 URL + Key 接入已部署的项目，
// 并自动检测版本差异，决定是否需要重新部署。

import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { Check, ChevronDown, ChevronUp, CloudUpload, ExternalLink, Loader2, MessageSquare, RefreshCw, Satellite, Link } from "lucide-react";
import {
    isCloudBackupConfigured,
    loadCloudBackupConfig,
    normalizeBackupUrl,
    saveCloudBackupConfig,
} from "@/lib/cloud-backup/config";
import { testCloudBackupConnection } from "@/lib/cloud-backup/storage-client";
import {
    buildWeixinCloudAssistantCronSql,
    deployWeixinCloudFunction,
    ensureWeixinCloudCronSecret,
    syncAllWeixinBotRuntimesToCloud,
} from "@/lib/weixin-cloud-sync";
import {
    connectExistingPushCloud,
    deployPersonalPushCloud,
    isPersonalPushCloudActive,
    PERSONAL_PUSH_SCHEMA_VERSION,
} from "@/lib/personal-push-cloud";
import { ensurePersonalPushSubscription, getOfflinePushState, markAccountPushSubscribed } from "@/lib/push-client";
import { getWeixinCloudDeployedAt, markWeixinCloudDeployed, savePushCloudScheduled, saveWeixinCloudScheduled } from "@/lib/cloud-deploy-status";
import { Input, Select } from "@/components/ui/form";

const SUPABASE_TOKENS_URL = "https://supabase.com/dashboard/account/tokens";

/** 设置页「云服务部署」独立条目的整页形态。 */
export function CloudServicesPage() {
    return (
        <div className="page-menu">
            <div className="menu-group" style={{ padding: "18px 16px" }}>
                <CloudServicesSetup />
            </div>
        </div>
    );
}

type OrganizationOption = { id: string; slug: string; name: string };

/** 版本检测结果 */
type CheckResult = {
    schemaVersion: number;
    isPersonalCloud: boolean;
    pushFunctionOk: boolean;
    weixinFunctionOk: boolean;
    needsRedeploy: boolean;
    redeployReason?: string;
};

function smartRegionForCurrentTimeZone(): "americas" | "emea" | "apac" {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
    if (/^(America|Atlantic)\//.test(zone)) return "americas";
    if (/^(Europe|Africa)\//.test(zone)) return "emea";
    return "apac";
}

function projectRefFromUrl(value: string): string {
    try {
        return new URL(normalizeBackupUrl(value)).hostname.split(".")[0] || "";
    } catch {
        return "";
    }
}

function wait(ms: number): Promise<void> {
    return new Promise(resolve => window.setTimeout(resolve, ms));
}

async function callSupabaseAdmin<T>(payload: Record<string, unknown>): Promise<T> {
    const res = await fetch("/api/supabase-admin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({})) as T & { ok?: boolean; error?: string };
    if (!res.ok || data.ok === false) {
        throw new Error(data.error || `管理接口返回 HTTP ${res.status}`);
    }
    return data;
}

export function CloudServicesSetup({ onConfigChanged }: { onConfigChanged?: () => void }) {
    // ── 状态显示 ──────────────────────────────────────────
    const [cloudReady, setCloudReady] = useState(false);
    const [pushActive, setPushActive] = useState(false);
    const [weixinDeployed, setWeixinDeployed] = useState(false);

    // ── 一键部署流程 ──────────────────────────────────────
    const [token, setToken] = useState("");
    const [organizations, setOrganizations] = useState<OrganizationOption[]>([]);
    const [selectedOrganizationSlug, setSelectedOrganizationSlug] = useState("");
    const [selectedRef, setSelectedRef] = useState("");
    const [scopeBackup, setScopeBackup] = useState(true);
    const [scopeWeixin, setScopeWeixin] = useState(true);
    const [scopePush, setScopePush] = useState(true);
    const [dialogOpen, setDialogOpen] = useState(false);
    const [busy, setBusy] = useState<"organizations" | "deploy" | "connect" | "check" | null>(null);
    const [resultDialog, setResultDialog] = useState<{ title: string; text: string; warn?: boolean } | null>(null);
    const [progress, setProgress] = useState("");

    // ── 手动连接已有项目 ──────────────────────────────────
    const [manualPanelOpen, setManualPanelOpen] = useState(false);
    const [manualUrl, setManualUrl] = useState("");
    const [manualKey, setManualKey] = useState("");
    const [checkResult, setCheckResult] = useState<CheckResult | null>(null);
    // 检测后若需重新部署，展示 Access Token 输入框
    const [redeployToken, setRedeployToken] = useState("");
    const [redeployDialogOpen, setRedeployDialogOpen] = useState(false);

    useEffect(() => {
        setCloudReady(isCloudBackupConfigured(loadCloudBackupConfig()));
        setPushActive(isPersonalPushCloudActive());
        setWeixinDeployed(Boolean(getWeixinCloudDeployedAt()));
        // 如果已有配置，预填手动面板
        const cfg = loadCloudBackupConfig();
        if (cfg.url) setManualUrl(cfg.url);
    }, []);

    const configuredUrl = normalizeBackupUrl(loadCloudBackupConfig().url);

    const refreshStatus = () => {
        setCloudReady(isCloudBackupConfigured(loadCloudBackupConfig()));
        setPushActive(isPersonalPushCloudActive());
        setWeixinDeployed(Boolean(getWeixinCloudDeployedAt()));
        onConfigChanged?.();
    };

    // ── 一键部署：打开部署范围弹窗 ───────────────────────
    const openScopeDialog = async () => {
        if (busy) return;
        setResultDialog(null);
        setBusy("organizations");
        try {
            const config = loadCloudBackupConfig();
            const configuredRef = projectRefFromUrl(config.url);

            // 优先级1：本机之前一键部署过的专用项目（有 managedProjectRef 标记）
            const managedRef = config.managedProjectRef === configuredRef ? configuredRef : "";

            // 优先级2：本机手动连接过的项目（有 URL+Key 但没有 managedProjectRef）
            // 通过 Access Token 查出该 projectRef 的 api-keys 确认项目存在，然后复用
            const manualConnectedRef = !managedRef && configuredRef && config.key ? configuredRef : "";

            if (managedRef || manualConnectedRef) {
                const existingRef = managedRef || manualConnectedRef;
                setProgress("确认已有项目…");

                // 用 Access Token 查一次项目状态，确认项目健康且 token 有效
                // 同时顺手把 managedProjectRef 补上，让后续重新部署流程更顺畅
                try {
                    const statusData = await callSupabaseAdmin<{ status: string }>({
                        action: "project_status", token, projectRef: existingRef,
                    });
                    if (!["ACTIVE_HEALTHY", "ACTIVE_UNHEALTHY"].includes(statusData.status)) {
                        throw new Error(`项目状态异常（${statusData.status}），请到 Supabase Dashboard 查看。`);
                    }
                    // 如果是手动连接的项目，顺手补上 managedProjectRef 标记
                    if (manualConnectedRef && !managedRef) {
                        saveCloudBackupConfig({
                            ...loadCloudBackupConfig(),
                            managedProjectRef: existingRef,
                        });
                    }
                } catch (err) {
                    // token 无效或项目不存在时，回退到新建流程
                    if (String(err).includes("管理接口") || String(err).includes("HTTP 4")) {
                        throw err;
                    }
                    // 其他错误（如项目状态异常）直接抛出
                    throw err;
                }

                setSelectedRef(existingRef);
                setOrganizations([]);
                setSelectedOrganizationSlug(config.managedOrganizationSlug || "");
            } else {
                // 没有任何已有项目记录，走新建流程
                const data = await callSupabaseAdmin<{ organizations: OrganizationOption[] }>({ action: "organizations", token });
                if (data.organizations.length === 0) throw new Error("该 Supabase 账号下没有可用组织。");
                setOrganizations(data.organizations);
                setSelectedOrganizationSlug(data.organizations.length === 1 ? data.organizations[0].slug : "");
                setSelectedRef("");
            }
            setScopeBackup(true);
            setScopeWeixin(true);
            setScopePush(true);
            setDialogOpen(true);
        } catch (err) {
            setResultDialog({ title: "部署失败", text: err instanceof Error ? err.message : String(err) });
        } finally {
            setProgress("");
            setBusy(null);
        }
    };

    const waitForProjectReady = async (projectRef: string): Promise<void> => {
        for (let attempt = 0; attempt < 90; attempt += 1) {
            const data = await callSupabaseAdmin<{ status: string }>({ action: "project_status", token, projectRef });
            if (data.status === "ACTIVE_HEALTHY") return;
            if (["INACTIVE", "REMOVED", "PAUSED"].includes(data.status)) {
                throw new Error(`新项目初始化停止（${data.status}），请到 Supabase Dashboard 查看。`);
            }
            await wait(2_000);
        }
        throw new Error("新项目仍在初始化。项目已经创建，请稍后再次点击部署继续。");
    };

    const waitForBackupStorageReady = async (): Promise<void> => {
        let lastError = "Storage 尚未就绪";
        for (let attempt = 0; attempt < 30; attempt += 1) {
            const bucket = await testCloudBackupConnection(loadCloudBackupConfig());
            if (bucket.ok) return;
            lastError = bucket.error || lastError;
            if (!/TenantNotFound|Missing tenant config for tenant/i.test(lastError)) {
                throw new Error(`备份桶创建失败：${lastError}`);
            }
            await wait(2_000);
        }
        throw new Error(`备份桶创建失败：${lastError}。项目已创建，请稍后再次点击部署继续。`);
    };

    const runDeploy = async () => {
        if (busy || (!selectedRef && !selectedOrganizationSlug) || (!scopeBackup && !scopeWeixin && !scopePush)) return;
        setResultDialog(null);
        setBusy("deploy");
        const done: string[] = [];
        try {
            let projectRef = selectedRef;
            if (!projectRef) {
                setProgress("创建专用项目…");
                const created = await callSupabaseAdmin<{ projectRef: string }>({
                    action: "create_project",
                    token,
                    organizationSlug: selectedOrganizationSlug,
                    regionCode: smartRegionForCurrentTimeZone(),
                });
                projectRef = created.projectRef;
                setSelectedRef(projectRef);
                saveCloudBackupConfig({
                    ...loadCloudBackupConfig(),
                    url: `https://${projectRef}.supabase.co`,
                    key: "",
                    managedProjectRef: projectRef,
                    managedOrganizationSlug: selectedOrganizationSlug,
                });
            }

            setProgress("等待项目初始化…");
            await waitForProjectReady(projectRef);

            setProgress("确认独立项目…");
            await callSupabaseAdmin({ action: "assert_dedicated_project", token, projectRef });
            await callSupabaseAdmin({
                action: "run_sql",
                token,
                projectRef,
                sql: `create table if not exists public.ai_phone_cloud_meta (
                    id text primary key,
                    schema_version integer not null default 1,
                    created_at timestamptz not null default now(),
                    updated_at timestamptz not null default now()
                );
                insert into public.ai_phone_cloud_meta (id, schema_version, updated_at)
                values ('personal-cloud', 3, now())
                on conflict (id) do update set schema_version = excluded.schema_version, updated_at = excluded.updated_at;`,
            });

            setProgress("取回项目密钥…");
            const keys = await callSupabaseAdmin<{ serviceRoleKey: string }>({ action: "api_keys", token, projectRef });
            saveCloudBackupConfig({
                ...loadCloudBackupConfig(),
                url: `https://${projectRef}.supabase.co`,
                key: keys.serviceRoleKey,
                managedProjectRef: projectRef,
                managedOrganizationSlug: selectedOrganizationSlug || loadCloudBackupConfig().managedOrganizationSlug,
            });

            if (scopeBackup) {
                setProgress("创建备份桶…");
                await waitForBackupStorageReady();
                done.push("云备份");
            }

            if (scopeWeixin) {
                setProgress("部署微信云函数…");
                await syncAllWeixinBotRuntimesToCloud().catch(() => []);
                const cronSecret = await ensureWeixinCloudCronSecret();
                await deployWeixinCloudFunction(token);
                setProgress("写入微信定时任务…");
                await callSupabaseAdmin({
                    action: "run_sql",
                    token,
                    projectRef,
                    sql: buildWeixinCloudAssistantCronSql(cronSecret),
                });
                markWeixinCloudDeployed();
                saveWeixinCloudScheduled(true);
                done.push("微信接入");
            }

            if (scopePush) {
                setProgress("部署离线推送…");
                const pushWasEnabled = await getOfflinePushState() === "on";
                await deployPersonalPushCloud(token);
                if (pushWasEnabled) {
                    const subscription = await ensurePersonalPushSubscription();
                    if (!subscription.ok) {
                        throw new Error(`离线推送已部署，但本设备订阅迁移失败：${subscription.error || "未知错误"}。请到推送设置里重新开启离线推送。`);
                    }
                } else {
                    markAccountPushSubscribed(false);
                }
                savePushCloudScheduled(true);
                done.push("离线推送");
            }

            setToken("");
            setDialogOpen(false);
            setResultDialog({ title: "部署完成", text: `${done.join("、")} 已就绪` });
        } catch (err) {
            setDialogOpen(false);
            setResultDialog({ title: "部署失败", text: err instanceof Error ? err.message : String(err) });
        } finally {
            setProgress("");
            setBusy(null);
            refreshStatus();
        }
    };

    // ── 手动连接：检测已有项目 ────────────────────────────
    const runConnect = async () => {
        if (busy) return;
        const url = manualUrl.trim();
        const key = manualKey.trim();
        if (!url || !key) {
            setResultDialog({ title: "请填写完整", text: "Supabase URL 和 service_role key 均不能为空。" });
            return;
        }
        setCheckResult(null);
        setBusy("connect");
        try {
            setProgress("连接并检测项目状态…");
            const result = await connectExistingPushCloud(url, key);
            setCheckResult({
                schemaVersion: result.schemaVersion,
                isPersonalCloud: result.healthStatus === "ready",
                pushFunctionOk: result.healthStatus === "ready",
                weixinFunctionOk: Boolean(getWeixinCloudDeployedAt()),
                needsRedeploy: result.needsRedeploy,
                redeployReason: result.redeployReason,
            });
            refreshStatus();
            if (!result.needsRedeploy) {
                setResultDialog({ title: "连接成功", text: `已成功连接到项目 ${projectRefFromUrl(url)}，云端版本 v${result.schemaVersion}，所有功能就绪。` });
            }
        } catch (err) {
            setResultDialog({ title: "连接失败", text: err instanceof Error ? err.message : String(err) });
        } finally {
            setProgress("");
            setBusy(null);
        }
    };

    // ── 手动连接：重新检测版本（已连接后刷新） ────────────
    const runRecheck = async () => {
        if (busy) return;
        const cfg = loadCloudBackupConfig();
        const url = cfg.url;
        const key = cfg.key;
        if (!url || !key) return;
        setBusy("check");
        setProgress("重新检测版本…");
        try {
            const projectRef = projectRefFromUrl(url);
            const data = await callSupabaseAdmin<{
                schemaVersion: number;
                isPersonalCloud: boolean;
                pushFunctionOk: boolean;
                weixinFunctionOk: boolean;
            }>({ action: "check_project", projectRef, serviceRoleKey: key });
            const needsRedeploy = !data.pushFunctionOk || data.schemaVersion < PERSONAL_PUSH_SCHEMA_VERSION;
            setCheckResult({
                ...data,
                needsRedeploy,
                redeployReason: needsRedeploy
                    ? (!data.pushFunctionOk
                        ? "离线推送云函数未响应，可能尚未部署。"
                        : `云端版本 v${data.schemaVersion}，当前需要 v${PERSONAL_PUSH_SCHEMA_VERSION}，需重新部署升级。`)
                    : undefined,
            });
        } catch (err) {
            setResultDialog({ title: "检测失败", text: err instanceof Error ? err.message : String(err) });
        } finally {
            setProgress("");
            setBusy(null);
        }
    };

    // ── 重新部署（版本升级）弹窗确认后执行 ───────────────
    const runRedeploy = async () => {
        if (busy || !redeployToken.trim()) return;
        setRedeployDialogOpen(false);
        setBusy("deploy");
        setProgress("升级部署中…");
        try {
            // 把当前 token 同步给一键部署流程使用
            const cfg = loadCloudBackupConfig();
            const projectRef = projectRefFromUrl(cfg.url);
            // 写入 token 供 openScopeDialog 使用，但这里直接走完整流程
            setSelectedRef(projectRef);
            setScopeBackup(true);
            setScopeWeixin(Boolean(getWeixinCloudDeployedAt()));
            setScopePush(true);

            setProgress("确认独立项目…");
            await callSupabaseAdmin({ action: "assert_dedicated_project", token: redeployToken, projectRef });
            await callSupabaseAdmin({
                action: "run_sql",
                token: redeployToken,
                projectRef,
                sql: `create table if not exists public.ai_phone_cloud_meta (
                    id text primary key,
                    schema_version integer not null default 1,
                    created_at timestamptz not null default now(),
                    updated_at timestamptz not null default now()
                );
                insert into public.ai_phone_cloud_meta (id, schema_version, updated_at)
                values ('personal-cloud', 3, now())
                on conflict (id) do update set schema_version = excluded.schema_version, updated_at = excluded.updated_at;`,
            });

            if (Boolean(getWeixinCloudDeployedAt())) {
                setProgress("升级微信云函数…");
                await syncAllWeixinBotRuntimesToCloud().catch(() => []);
                const cronSecret = await ensureWeixinCloudCronSecret();
                await deployWeixinCloudFunction(redeployToken);
                await callSupabaseAdmin({
                    action: "run_sql",
                    token: redeployToken,
                    projectRef,
                    sql: buildWeixinCloudAssistantCronSql(cronSecret),
                });
                markWeixinCloudDeployed();
                saveWeixinCloudScheduled(true);
            }

            setProgress("升级离线推送…");
            const pushWasEnabled = await getOfflinePushState() === "on";
            await deployPersonalPushCloud(redeployToken);
            if (pushWasEnabled) {
                const subscription = await ensurePersonalPushSubscription();
                if (!subscription.ok) {
                    throw new Error(`离线推送已升级，但本设备订阅迁移失败：${subscription.error || "未知错误"}。请到推送设置里重新开启。`);
                }
            } else {
                markAccountPushSubscribed(false);
            }
            savePushCloudScheduled(true);

            setRedeployToken("");
            setCheckResult(null);
            setResultDialog({ title: "升级完成", text: "云端已升级到最新版本，所有功能就绪。" });
        } catch (err) {
            setResultDialog({ title: "升级失败", text: err instanceof Error ? err.message : String(err) });
        } finally {
            setProgress("");
            setBusy(null);
            refreshStatus();
        }
    };

    // ── UI 辅助组件 ───────────────────────────────────────
    const scopeRow = (
        label: string,
        checked: boolean,
        onChange: (v: boolean) => void,
        deployed: boolean,
    ) => (
        <label className="flex items-center gap-3 rounded-[14px] bg-black/[0.03] px-3 py-2.5">
            <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
            <span className="menu-label flex-1">{label}</span>
            {deployed && <span className="text-[11px] font-semibold text-green-600">已部署</span>}
        </label>
    );

    const statusCard = (
        icon: ReactNode,
        label: string,
        deployed: boolean,
        deployedText: string,
    ) => (
        <div className="flex items-center gap-3 rounded-[16px] bg-black/[0.03] px-3.5 py-3">
            <span
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white shadow-sm"
                style={{ color: deployed ? "var(--c-success, #16a34a)" : "var(--c-text-sub, #999)" } as CSSProperties}
            >
                {icon}
            </span>
            <div className="flex min-w-0 flex-1 flex-col">
                <span className="menu-label">{label}</span>
                <span className="menu-desc !mt-0 min-w-0 truncate">{deployed ? deployedText : "未部署"}</span>
            </div>
            <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${deployed ? "bg-green-500" : "bg-black/15"}`} />
        </div>
    );

    const isBusy = Boolean(busy);

    return (
        <div className="flex flex-col gap-4">
            {/* ── 一键部署区域 ── */}
            <div className="flex flex-col items-center justify-center gap-2 pt-1">
                <button
                    type="button"
                    className="inline-flex items-center justify-center gap-1.5 rounded-[20px] bg-black px-6 py-2.5 text-sm font-bold text-white shadow-sm transition-all hover:bg-gray-800 hover:shadow-md active:scale-95 focus:outline-none"
                    onClick={() => window.open(SUPABASE_TOKENS_URL, "_blank", "noopener")}
                >
                    <ExternalLink size={15} strokeWidth={1.8} />
                    打开 Supabase 令牌页
                </button>
                <p className="text-[calc(11px*var(--app-text-scale,1))] font-medium text-gray-400">生成 Access Token 后复制粘贴；只用一次，不保存</p>
            </div>

            {/* token 输入 + 圆形确认钮 */}
            <div className="flex items-center gap-2">
                <Input
                    type="password"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    placeholder="sbp_… Access Token"
                    spellCheck={false}
                    className="flex-1 min-w-0"
                />
                <button
                    type="button"
                    aria-label="确认并选择 Supabase 组织与部署范围"
                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-black text-white shadow-sm transition-all hover:bg-gray-800 active:scale-95 disabled:opacity-30 focus:outline-none"
                    onClick={() => void openScopeDialog()}
                    disabled={isBusy || !token.trim()}
                >
                    {busy === "organizations" ? <Loader2 size={17} className="animate-spin" /> : <Check size={18} strokeWidth={2.2} />}
                </button>
            </div>

            {/* ── 三项状态卡片 ── */}
            <div className="flex flex-col gap-2">
                {statusCard(<CloudUpload size={17} strokeWidth={1.9} />, "云备份", cloudReady, `已连接 · ${configuredUrl.replace(/^https?:\/\//, "").replace(/\.supabase\.co$/, "")}`)}
                {statusCard(<MessageSquare size={17} strokeWidth={1.9} />, "微信接入", weixinDeployed, "云函数与定时任务已部署")}
                {statusCard(<Satellite size={17} strokeWidth={1.9} />, "离线推送", pushActive, "已部署到你的 Supabase")}
            </div>

            {/* ── 分隔线 ── */}
            <div className="flex items-center gap-2">
                <div className="flex-1 border-t border-black/[0.06]" />
                <span className="text-[11px] font-medium text-gray-400">其他设备 / 已有项目</span>
                <div className="flex-1 border-t border-black/[0.06]" />
            </div>

            {/* ── 手动连接面板 ── */}
            <div className="flex flex-col gap-0 rounded-[18px] border border-black/[0.07] overflow-hidden">
                {/* 折叠标题栏 */}
                <button
                    type="button"
                    className="flex items-center gap-2.5 px-4 py-3 text-left hover:bg-black/[0.02] transition-colors focus:outline-none"
                    onClick={() => setManualPanelOpen(v => !v)}
                >
                    <Link size={15} strokeWidth={1.9} className="shrink-0 text-gray-500" />
                    <div className="flex-1 min-w-0">
                        <p className="menu-label">手动连接已有项目</p>
                        <p className="menu-desc !mt-0">在其他端填写 URL + Key 直接接入，自动检测版本</p>
                    </div>
                    {manualPanelOpen
                        ? <ChevronUp size={15} className="shrink-0 text-gray-400" />
                        : <ChevronDown size={15} className="shrink-0 text-gray-400" />}
                </button>

                {/* 展开内容 */}
                {manualPanelOpen && (
                    <div className="flex flex-col gap-3 px-4 pb-4 pt-1 border-t border-black/[0.05]">
                        <p className="menu-desc !mt-0 text-[11px]">
                            从已部署的设备复制「Supabase URL」和「service_role key」填入，本设备即可接入同一个个人云，无需重新部署。
                        </p>

                        <label className="flex flex-col gap-1">
                            <span className="menu-desc !mt-0 text-[11px] font-medium">Supabase URL</span>
                            <Input
                                type="url"
                                value={manualUrl}
                                onChange={(e) => { setManualUrl(e.target.value); setCheckResult(null); }}
                                placeholder="https://xxxx.supabase.co"
                                spellCheck={false}
                                disabled={isBusy}
                            />
                        </label>

                        <label className="flex flex-col gap-1">
                            <span className="menu-desc !mt-0 text-[11px] font-medium">service_role key</span>
                            <Input
                                type="password"
                                value={manualKey}
                                onChange={(e) => { setManualKey(e.target.value); setCheckResult(null); }}
                                placeholder="eyJhbGciOiJIUzI1NiIs…"
                                spellCheck={false}
                                disabled={isBusy}
                            />
                        </label>

                        <button
                            type="button"
                            className="ui-btn ui-btn-primary"
                            onClick={() => void runConnect()}
                            disabled={isBusy || !manualUrl.trim() || !manualKey.trim()}
                        >
                            {busy === "connect"
                                ? <><Loader2 size={14} className="animate-spin" /> {progress || "检测中…"}</>
                                : "连接并检测版本"}
                        </button>

                        {/* 检测结果展示 */}
                        {checkResult && (
                            <div className={`flex flex-col gap-2 rounded-[14px] px-3 py-3 ${checkResult.needsRedeploy ? "bg-amber-50 border border-amber-200" : "bg-green-50 border border-green-200"}`}>
                                <div className="flex items-center gap-2">
                                    <span className={`h-2 w-2 rounded-full shrink-0 ${checkResult.needsRedeploy ? "bg-amber-400" : "bg-green-500"}`} />
                                    <span className="text-[12px] font-semibold">
                                        {checkResult.needsRedeploy ? "需要升级部署" : "版本匹配，已就绪"}
                                    </span>
                                    <button
                                        type="button"
                                        className="ml-auto flex items-center gap-1 text-[11px] text-gray-500 hover:text-gray-700"
                                        onClick={() => void runRecheck()}
                                        disabled={isBusy}
                                    >
                                        {busy === "check"
                                            ? <Loader2 size={11} className="animate-spin" />
                                            : <RefreshCw size={11} />}
                                        重新检测
                                    </button>
                                </div>

                                <div className="flex flex-col gap-1 text-[11px] text-gray-600">
                                    <div className="flex justify-between">
                                        <span>云端 schema 版本</span>
                                        <span className="font-mono font-medium">v{checkResult.schemaVersion} / v{PERSONAL_PUSH_SCHEMA_VERSION}</span>
                                    </div>
                                    <div className="flex justify-between">
                                        <span>离线推送云函数</span>
                                        <span className={checkResult.pushFunctionOk ? "text-green-600 font-medium" : "text-red-500 font-medium"}>
                                            {checkResult.pushFunctionOk ? "✓ 正常" : "✗ 未就绪"}
                                        </span>
                                    </div>
                                    <div className="flex justify-between">
                                        <span>个人云标记</span>
                                        <span className={checkResult.isPersonalCloud ? "text-green-600 font-medium" : "text-amber-600 font-medium"}>
                                            {checkResult.isPersonalCloud ? "✓ 已确认" : "⚠ 未检测到"}
                                        </span>
                                    </div>
                                </div>

                                {checkResult.needsRedeploy && checkResult.redeployReason && (
                                    <p className="text-[11px] text-amber-700 leading-relaxed">
                                        {checkResult.redeployReason}
                                    </p>
                                )}

                                {checkResult.needsRedeploy && (
                                    <button
                                        type="button"
                                        className="ui-btn ui-btn-primary mt-1"
                                        style={{ background: "var(--c-warning, #d97706)", borderColor: "var(--c-warning, #d97706)" } as CSSProperties}
                                        onClick={() => setRedeployDialogOpen(true)}
                                        disabled={isBusy}
                                    >
                                        升级部署到最新版本
                                    </button>
                                )}
                            </div>
                        )}

                        {/* 已配置时显示快速重新检测 */}
                        {!checkResult && cloudReady && !manualKey && (
                            <button
                                type="button"
                                className="flex items-center justify-center gap-1.5 text-[12px] text-gray-500 hover:text-gray-700 py-1"
                                onClick={() => void runRecheck()}
                                disabled={isBusy}
                            >
                                {busy === "check"
                                    ? <Loader2 size={12} className="animate-spin" />
                                    : <RefreshCw size={12} />}
                                检测当前已连接项目的版本
                            </button>
                        )}
                    </div>
                )}
            </div>

            {/* ── 结果弹窗 ── */}
            {resultDialog && (
                <div className="modal-overlay" data-ui="modal" onClick={() => setResultDialog(null)}>
                    <div
                        className="modal-dialog"
                        role="alertdialog"
                        aria-modal="true"
                        aria-label={resultDialog.title}
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="modal-body flex flex-col gap-2">
                            <h3 className="modal-title">{resultDialog.title}</h3>
                            <p className="menu-desc !mt-0" style={{ wordBreak: "break-word" }}>{resultDialog.text}</p>
                        </div>
                        <div className="modal-footer">
                            <button type="button" className="ui-btn ui-btn-primary" onClick={() => setResultDialog(null)}>
                                知道了
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* ── 一键部署范围弹窗 ── */}
            {dialogOpen && (
                <div className="modal-overlay" data-ui="modal" onClick={() => { if (busy !== "deploy") setDialogOpen(false); }}>
                    <div
                        className="modal-dialog"
                        role="dialog"
                        aria-modal="true"
                        aria-label="创建个人云项目并选择部署范围"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="modal-body flex flex-col gap-3">
                            <h3 className="modal-title">部署个人云</h3>
                            {!selectedRef ? (
                                <div className="menu-desc !mt-0 rounded-[14px] bg-black/[0.03] px-3 py-2.5">
                                    将新建独立的「AI Phone Personal Cloud」项目，不会写入任何已有项目。
                                </div>
                            ) : (
                                <div className="menu-desc !mt-0 rounded-[14px] bg-black/[0.03] px-3 py-2.5">
                                    检测到已连接项目 <span className="font-mono font-medium">{selectedRef}</span>，将直接更新该项目的云函数与数据库，无需新建。
                                </div>
                            )}
                            {!selectedRef && (
                                <label className="flex flex-col gap-1">
                                    <span className="menu-desc !mt-0">创建到哪个 Supabase 组织</span>
                                    <Select value={selectedOrganizationSlug} onChange={(e) => setSelectedOrganizationSlug(e.target.value)}>
                                        <option value="" disabled>请选择…</option>
                                        {organizations.map(org => (
                                            <option key={org.slug} value={org.slug}>
                                                {org.name || org.slug}
                                            </option>
                                        ))}
                                    </Select>
                                </label>
                            )}
                            {scopeRow("云备份", scopeBackup, setScopeBackup, cloudReady)}
                            {scopeRow("微信接入", scopeWeixin, setScopeWeixin, weixinDeployed)}
                            {scopeRow("离线推送", scopePush, setScopePush, pushActive)}
                        </div>
                        <div className="modal-footer">
                            <button
                                type="button"
                                className="ui-btn ui-btn-outline"
                                onClick={() => setDialogOpen(false)}
                                disabled={busy === "deploy"}
                            >
                                取消
                            </button>
                            <button
                                type="button"
                                className={`ui-btn ui-btn-primary ${busy === "deploy" ? "is-busy" : ""}`}
                                onClick={() => void runDeploy()}
                                disabled={isBusy || (!selectedRef && !selectedOrganizationSlug) || (!scopeBackup && !scopeWeixin && !scopePush)}
                            >
                                {busy === "deploy"
                                    ? <><Loader2 size={15} className="animate-spin" /> {progress || "部署中…"}</>
                                    : selectedRef ? "开始部署" : "创建并部署"}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* ── 升级部署确认弹窗 ── */}
            {redeployDialogOpen && (
                <div className="modal-overlay" data-ui="modal" onClick={() => { if (!isBusy) setRedeployDialogOpen(false); }}>
                    <div
                        className="modal-dialog"
                        role="dialog"
                        aria-modal="true"
                        aria-label="升级部署到最新版本"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="modal-body flex flex-col gap-3">
                            <h3 className="modal-title">升级部署</h3>
                            <p className="menu-desc !mt-0">
                                将把云函数和数据库 schema 升级到 v{PERSONAL_PUSH_SCHEMA_VERSION}。
                                需要 Supabase Access Token 授权（只用一次，不保存）。
                            </p>
                            {checkResult?.redeployReason && (
                                <div className="rounded-[12px] bg-amber-50 border border-amber-200 px-3 py-2 text-[12px] text-amber-700">
                                    {checkResult.redeployReason}
                                </div>
                            )}
                            <label className="flex flex-col gap-1">
                                <span className="menu-desc !mt-0 text-[11px] font-medium">Access Token</span>
                                <Input
                                    type="password"
                                    value={redeployToken}
                                    onChange={(e) => setRedeployToken(e.target.value)}
                                    placeholder="sbp_… Access Token"
                                    spellCheck={false}
                                    autoFocus
                                />
                            </label>
                            <button
                                type="button"
                                className="inline-flex items-center justify-center gap-1 text-[11px] text-gray-400 hover:text-gray-600"
                                onClick={() => window.open(SUPABASE_TOKENS_URL, "_blank", "noopener")}
                            >
                                <ExternalLink size={11} />
                                打开 Supabase 令牌页生成 Token
                            </button>
                        </div>
                        <div className="modal-footer">
                            <button
                                type="button"
                                className="ui-btn ui-btn-outline"
                                onClick={() => setRedeployDialogOpen(false)}
                                disabled={isBusy}
                            >
                                取消
                            </button>
                            <button
                                type="button"
                                className={`ui-btn ui-btn-primary ${busy === "deploy" ? "is-busy" : ""}`}
                                onClick={() => void runRedeploy()}
                                disabled={isBusy || !redeployToken.trim()}
                            >
                                {busy === "deploy"
                                    ? <><Loader2 size={15} className="animate-spin" /> {progress || "升级中…"}</>
                                    : "确认升级"}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
