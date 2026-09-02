/**
 * Dock 管理面板容器：header（标题/计数徽标/关闭）+ 恢复 banner + tab 切换 + 拖放提示。
 * 只做面板级协调（activeTab 切换、badge 计数汇总、面板拖放），记忆/召回两个 tab
 * 的 state 与 effect 各自下沉到 MemoryTab / RecallTab。
 * @module dsh-echo-memory/client/dock-panel
 */

import { useState } from 'react'
import { elephantImage } from './elephantImage.ts'
import type { StorageRecovered, Toast } from './dock-util.ts'
import { MemoryTab } from './memory-tab.tsx'
import { RecallTab } from './recall-tab.tsx'

/** 面板级轻提示浮层（右下角固定，面板打开时显示在其上方）。 */
export function DockToast(props: { toast: Toast | null; bottom: number }) {
  if (!props.toast) return null
  return (
    <div
      style={{
        position: 'fixed',
        bottom: `${props.bottom}px`,
        right: '20px',
        padding: '8px 12px',
        borderRadius: '8px',
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l2)',
        boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
        fontSize: '12px',
        color: props.toast.kind === 'error' ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-primary)',
        zIndex: 41,
        maxWidth: 'min(320px, calc(100vw - 32px))',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }}
    >
      {props.toast.text}
    </div>
  )
}

export function DockManagePanel(props: {
  onClose: () => void
  storageRecovered: StorageRecovered | null
  dismissedRecovery: boolean
  onDismissRecovery: () => void
  toast: Toast | null
  onToast: (text: string, kind?: Toast['kind']) => void
  /** 拖文字到面板直接记住（保存 + 反馈 + 刷新由父层完成）。 */
  onDropText: (text: string) => void
  /** 记忆列表外部刷新信号（拖放保存成功后父层自增，驱动 MemoryTab 重拉）。 */
  refreshSignal: number
  saveWorkspace: string
  onSaveWorkspaceChange: (workspace: string) => void
}) {
  const [activeTab, setActiveTab] = useState<'memory' | 'recall'>('memory')
  const [isPanelDropOver, setIsPanelDropOver] = useState(false)
  const [memoryCount, setMemoryCount] = useState(0)
  const [recallCount, setRecallCount] = useState(0)

  const panelDropHandlers = {
    onDragOver: (e: React.DragEvent) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; if (!isPanelDropOver) setIsPanelDropOver(true) },
    onDragEnter: (e: React.DragEvent) => { e.preventDefault(); setIsPanelDropOver(true) },
    onDragLeave: (e: React.DragEvent) => {
      const rel = e.relatedTarget as HTMLElement | null
      if (rel && (e.currentTarget as HTMLElement).contains(rel)) return
      setIsPanelDropOver(false)
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault()
      setIsPanelDropOver(false)
      const t = e.dataTransfer.getData('text/plain') || e.dataTransfer.getData('text') || ''
      if (t.trim().length >= 2) props.onDropText(t)
    },
  }

  const tabButton = (tab: 'memory' | 'recall', label: string) => (
    <button
      type="button"
      onClick={() => setActiveTab(tab)}
      style={{
        flex: 1,
        padding: '6px 8px',
        borderRadius: '8px',
        border: activeTab === tab ? '1px solid var(--dsw-alias-border-l2)' : '1px solid transparent',
        background: activeTab === tab ? 'var(--dsw-alias-bg-layer-3)' : 'transparent',
        color: activeTab === tab ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-tertiary)',
        fontSize: '12px',
        fontWeight: activeTab === tab ? 600 : 400,
        cursor: 'pointer',
      }}
    >
      {label}
    </button>
  )

  const countBadge = (count: number) => (
    <span style={{ fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)', background: 'var(--dsw-alias-bg-layer-3)', padding: '1px 6px', borderRadius: '999px' }}>{count}</span>
  )

  return (
    <>
      <div
        {...panelDropHandlers}
        style={{
          position: 'fixed',
          bottom: '20px',
          right: '20px',
          width: 'min(380px, calc(100vw - 32px))',
          maxHeight: 'min(480px, calc(100vh - 80px))',
          display: 'flex',
          flexDirection: 'column',
          borderRadius: '12px',
          background: 'var(--dsw-alias-bg-layer-2)',
          border: isPanelDropOver ? '1px solid var(--dsw-alias-brand-primary)' : '1px solid var(--dsw-alias-border-l2)',
          boxShadow: isPanelDropOver ? '0 16px 40px rgba(0,0,0,0.16), 0 0 0 2px rgba(99,102,241,0.15)' : '0 16px 40px rgba(0,0,0,0.16), 0 4px 12px rgba(0,0,0,0.08)',
          zIndex: 40,
          overflow: 'hidden',
          transition: 'border-color .15s, box-shadow .15s',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 14px', borderBottom: '1px solid var(--dsw-alias-border-l2)', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <img src={elephantImage} alt="" draggable={false} onDragStart={(e) => e.preventDefault()} style={{ width: '20px', height: '20px', borderRadius: '50%', objectFit: 'cover', display: 'block', border: '1px solid white', boxShadow: '0 1px 4px rgba(0,0,0,0.08)', pointerEvents: 'none', userSelect: 'none' }} />
            <span style={{ fontSize: '13px', fontWeight: 700, color: 'var(--dsw-alias-label-primary)' }}>记忆</span>
            {activeTab === 'memory' ? countBadge(memoryCount) : countBadge(recallCount)}
          </div>
          <button
            type="button"
            onClick={props.onClose}
            style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--dsw-alias-label-tertiary)', fontSize: '16px', padding: '2px 6px' }}
          >
            ×
          </button>
        </div>

        {props.storageRecovered && !props.dismissedRecovery && (
          <div style={{ margin: '8px 14px 0', padding: '8px 10px', borderRadius: '8px', border: '1px dashed var(--dsw-alias-state-error-primary)', background: 'rgba(236,19,19,0.06)', fontSize: '12px', color: 'var(--dsw-alias-state-error-primary)', display: 'flex', gap: '8px', alignItems: 'center', flexShrink: 0 }}>
            <span style={{ flex: 1 }}>⚠️ 检测到记忆文件曾损坏，已自动备份并重置（备份：{props.storageRecovered.backupPath.split('/').pop()}）</span>
            <button type="button" onClick={props.onDismissRecovery} style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: '13px', color: 'inherit', padding: '0 2px' }} aria-label="关闭">×</button>
          </div>
        )}

        <div style={{ display: 'flex', gap: '4px', padding: '8px 14px 0', flexShrink: 0 }}>
          {tabButton('memory', '记忆')}
          {tabButton('recall', '召回历史')}
        </div>

        {isPanelDropOver && (
          <div style={{ margin: '8px 14px 0', padding: '8px 10px', borderRadius: '8px', border: '1px dashed var(--dsw-alias-brand-primary)', background: 'rgba(99,102,241,0.06)', fontSize: '12px', color: 'var(--dsw-alias-brand-primary)', textAlign: 'center', flexShrink: 0 }}>
            松手即可记住
          </div>
        )}

        {activeTab === 'memory' ? (
          <MemoryTab
            onToast={props.onToast}
            onCount={setMemoryCount}
            refreshSignal={props.refreshSignal}
            saveWorkspace={props.saveWorkspace}
            onSaveWorkspaceChange={props.onSaveWorkspaceChange}
          />
        ) : (
          <RecallTab onToast={props.onToast} onCount={setRecallCount} />
        )}
      </div>
      <DockToast toast={props.toast} bottom={510} />
    </>
  )
}
