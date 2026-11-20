// MTE Flow panel: start-run form, install button and the runs/workers table. No build step.
import {
  atom,
  Badge,
  Button,
  Callout,
  Code,
  EmptyState,
  Heading,
  KeyValue,
  on,
  plugin,
  read,
  Row,
  Select,
  set,
  Stack,
  Table,
  Text,
  Textarea,
  Input,
  update,
  type PanelContext
} from 'orca'
import './protocol'

type Snapshot = Awaited<ReturnType<typeof loadState>>

const snapshot = atom<Snapshot | null>(null)
const loadError = atom<string | null>(null)
const goal = atom('')
const plannerAgent = atom('claude')
const plannerModel = atom('')
const busy = atom<string | null>(null)
const notice = atom<{ tone: 'success' | 'danger'; text: string } | null>(null)
const prefilled = atom(false)

const loadState = () => plugin.request('state.get', {})

async function refresh(): Promise<void> {
  try {
    const next = await loadState()
    set(snapshot, next)
    set(loadError, null)
    if (!read(prefilled)) {
      set(prefilled, true)
      set(plannerAgent, next.settings.plannerAgent)
      set(plannerModel, next.settings.plannerModel)
    }
  } catch (error) {
    set(loadError, String((error as Error).message ?? error))
  }
}

async function act<T extends { ok: boolean }>(
  name: string,
  run: () => Promise<T | { ok: false; error: { message: string } }>,
  success: (result: T) => string
): Promise<void> {
  set(busy, name)
  set(notice, null)
  try {
    const result = await run()
    set(
      notice,
      result.ok
        ? { tone: 'success', text: success(result as T) }
        : { tone: 'danger', text: (result as { error: { message: string } }).error.message }
    )
  } catch (error) {
    set(notice, { tone: 'danger', text: String((error as Error).message ?? error) })
  } finally {
    set(busy, null)
    void refresh()
  }
}

const startRun = () =>
  act(
    'start',
    () => plugin.request('run.start', { goal: read(goal), plannerAgent: read(plannerAgent), plannerModel: read(plannerModel) }),
    (r) =>
      `Planner started in a new terminal${r.truncated ? ' (goal truncated to fit the 4096-char prompt cap)' : ''}.`
  )

const install = () => act('install', () => plugin.request('workspace.install', {}), () => 'MTE installed in this workspace.')

const focus = (workspace: string) =>
  act('focus', () => plugin.request('workspace.focus', { workspace }), () => 'Workspace focused.')

export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(
    plugin.on('state.changed', () => void refresh()),
    on('agent.status.changed', () => void refresh()),
    // The focused workspace changed: the shown name/path must follow it, never a stale one.
    on('workspace.changed', () => void refresh())
  )
  void refresh()
}

const AGENTS = [
  { value: 'claude', label: 'Claude Code' },
  { value: 'opencode', label: 'opencode' }
]

export default function Panel() {
  const snap = read(snapshot)
  const working = read(busy)
  const msg = read(notice)
  const loadErr = read(loadError)
  const workers = snap?.workers ?? []
  const activeCount = workers.filter((w) => w.active).length

  return (
    <Stack gap="md">
      <Row justify="between">
        <Heading>MTE Flow</Heading>
        <Badge tone={activeCount > 0 ? 'accent' : 'neutral'}>{activeCount} active</Badge>
      </Row>

      {loadErr ? (
        <Callout tone="danger" title="Could not reach the MTE worker">
          {loadErr}
        </Callout>
      ) : null}
      {snap?.mte.missing ? (
        <Callout tone="danger" title="mte binary not found">
          {snap.mte.message} <Code>npm i -g @mtekode/mte</Code>
        </Callout>
      ) : null}
      {msg ? (
        <Callout tone={msg.tone === 'success' ? 'success' : 'danger'}>{msg.text}</Callout>
      ) : null}

      <Stack gap="sm">
        <Heading level={2}>Start run</Heading>
        <KeyValue
          items={[
            { label: 'Workspace', value: snap?.workspace ? snap.workspace.name : 'none focused' },
            { label: 'Path', value: snap?.workspace?.path ?? '-', code: true }
          ]}
        />
        <Textarea
          label="Goal"
          rows={4}
          placeholder="What should MTE build?"
          value={read(goal)}
          onChange={(value) => set(goal, value)}
        />
        <Row gap="xs">
          <Select
            label="Planner agent"
            options={AGENTS}
            value={read(plannerAgent)}
            onChange={(value) => set(plannerAgent, value)}
          />
          <Input
            label="Planner model"
            placeholder="agent default"
            value={read(plannerModel)}
            onChange={(value) => set(plannerModel, value)}
          />
        </Row>
        <Row gap="xs">
          <Button
            icon="play"
            disabled={working !== null || !read(goal).trim() || !snap?.workspace}
            onPress={() => void startRun()}
          >
            {working === 'start' ? 'Starting…' : 'Start run'}
          </Button>
          <Button
            variant="outline"
            icon="download"
            disabled={working !== null || !snap?.workspace}
            onPress={() => void install()}
          >
            Install MTE in this workspace
          </Button>
        </Row>
        <Text muted size="xs">
          Planner in a native chat? Type <Code>/mte-flow your goal</Code> there instead.
        </Text>
      </Stack>

      <Stack gap="sm">
        <Heading level={2}>Workers</Heading>
        {snap?.error ? (
          <Callout tone="warning" title="Could not read orchestration state">
            {snap.error.message}
          </Callout>
        ) : null}
        {workers.length === 0 ? (
          <EmptyState title="No workers" description="Workers dispatched by an MTE planner show up here." />
        ) : (
          <Stack gap="xs">
            {workers.map((w) => (
              <Row key={w.dispatchId} justify="between" align="center" gap="xs">
                <Stack gap="none">
                  <Text size="sm" weight="medium" truncate>
                    {w.taskId} · {w.agent}
                  </Text>
                  <Text size="xs" muted truncate>
                    {w.state} / {w.outcome} · {w.workspace.split('/').pop() ?? w.workspace}
                  </Text>
                </Stack>
                <Row gap="xs" align="center">
                  <Badge tone={w.active ? 'accent' : 'neutral'}>{w.active ? 'active' : w.outcome || 'idle'}</Badge>
                  <Button size="sm" variant="ghost" disabled={working !== null} onPress={() => void focus(w.workspace)}>
                    Focus
                  </Button>
                </Row>
              </Row>
            ))}
          </Stack>
        )}
      </Stack>

      {snap && snap.runs.length > 0 ? (
        <Stack gap="sm">
          <Heading level={2}>Runs</Heading>
          <Table
            label="MTE runs"
            columns={[
              { key: 'id', label: 'Run' },
              { key: 'objective', label: 'Objective' }
            ]}
            rows={snap.runs.map((r) => ({ key: r.id, cells: { id: r.id, objective: r.objective } }))}
          />
        </Stack>
      ) : null}
    </Stack>
  )
}
