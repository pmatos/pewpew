import { useId, useState } from 'react'
import type { AgentTool } from '../../shared/types'

const TOOL_OPTIONS = [
  ['claude', 'Claude'],
  ['codex', 'Codex'],
  ['omp', 'oh-my-pi'],
] as const

interface SessionOptions {
  tool: AgentTool
  skipPermissions: boolean
  setTool: (tool: AgentTool) => void
  setSkipPermissions: (checked: boolean) => void
  // The flag only applies to claude; never send it for other tools.
  toCreateOptions: () => { tool: AgentTool; skipPermissions: boolean }
}

export function useSessionOptions(
  defaultTool: AgentTool,
  defaultSkipPermissions: boolean
): SessionOptions {
  const [tool, setTool] = useState<AgentTool>(defaultTool)
  const [skipPermissions, setSkipPermissions] = useState(defaultSkipPermissions)
  return {
    tool,
    skipPermissions,
    setTool,
    setSkipPermissions,
    toCreateOptions: () => ({ tool, skipPermissions: tool === 'claude' && skipPermissions }),
  }
}

export function SessionOptionsFields({ options }: { options: SessionOptions }) {
  const groupName = useId()
  return (
    <>
      <div className="session-name-label">Tool:</div>
      <div className="tool-picker">
        {TOOL_OPTIONS.map(([value, label]) => (
          <label key={value}>
            <input
              type="radio"
              name={groupName}
              value={value}
              checked={options.tool === value}
              onChange={() => options.setTool(value)}
            />
            {label}
          </label>
        ))}
      </div>
      {options.tool === 'claude' && (
        <label
          className="session-base-checkbox"
          title="Runs claude with --dangerously-skip-permissions instead of --permission-mode auto. Claude is not sandboxed."
        >
          <input
            type="checkbox"
            checked={options.skipPermissions}
            onChange={(e) => options.setSkipPermissions(e.target.checked)}
          />
          <span>Skip permission prompts (--dangerously-skip-permissions)</span>
        </label>
      )}
    </>
  )
}
