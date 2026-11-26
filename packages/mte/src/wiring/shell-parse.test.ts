import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { findGitHookBypass, findInvocations } from './shell-parse.ts'

type Case = { cmd: string; want: ('run-create' | 'worker-start')[]; args?: string[]; note?: string }

const RUN = 'orca orchestration run-create --objective x'
const START = 'orca orchestration worker-start --task T-1'

/** Table pins for findInvocations: recognised calls, wrappers, quoting, chains, and the documented known limits. */
const CASES: Case[] = [
  // plain calls
  { cmd: RUN, want: ['run-create'] },
  { cmd: START, want: ['worker-start'] },
  { cmd: 'orca orchestration inbox', want: [] },
  { cmd: 'orca orchestration run-create --help', want: [], note: 'usage probe' },
  { cmd: 'orca orchestration worker-start -h', want: [], note: 'usage probe' },
  { cmd: 'notorca orchestration worker-start --task x', want: [] },
  { cmd: '/Applications/Orca.app/Contents/Resources/bin/orca orchestration worker-start --task x', want: ['worker-start'] },
  // wrappers
  { cmd: `env FOO=1 ${RUN}`, want: ['run-create'] },
  { cmd: 'env -i /usr/local/bin/orca orchestration worker-start --task x', want: ['worker-start'] },
  { cmd: `command ${START}`, want: ['worker-start'] },
  { cmd: `exec ${RUN}`, want: ['run-create'] },
  { cmd: `sudo ${START}`, want: ['worker-start'] },
  { cmd: `xargs ${START}`, want: ['worker-start'] },
  { cmd: `nice ${START}`, want: ['worker-start'] },
  { cmd: `nohup ${START}`, want: ['worker-start'] },
  // $ORCA_CLI_COMMAND spellings
  { cmd: `$ORCA_CLI_COMMAND ${'orchestration run-create'}`, want: ['run-create'] },
  { cmd: `"${'${ORCA_CLI_COMMAND}'}" orchestration worker-start --task x`, want: ['worker-start'] },
  // chains, subshells, pipes
  { cmd: `cd x && ${START}; echo hi | orca orchestration run-create`, want: ['worker-start', 'run-create'] },
  { cmd: `(cd x; ${START})`, want: ['worker-start'] },
  // bash -c / eval scripts are re-parsed
  { cmd: `bash -c "${START}"`, want: ['worker-start'] },
  { cmd: `eval "${RUN}"`, want: ['run-create'] },
  // real substitutions, quoted prose / heredoc bodies / backticks-in-quotes are data
  { cmd: `echo $(${START})`, want: ['worker-start'] },
  { cmd: `orca orchestration task-create --spec 'never call ${START} yourself'`, want: [], note: 'single-quoted prose' },
  { cmd: 'echo "the doc says `orca orchestration worker-start --task 1`"', want: [], note: 'backticks inside double quotes are data' },
  { cmd: `cat <<EOF\nbefore\n${RUN}\nEOF`, want: [], note: 'heredoc body' },
  { cmd: `cat <<EOF\nbefore\nEOF\n${RUN}`, want: ['run-create'], note: 'call after the heredoc still counts' },
  // redirections vanish with their targets
  { cmd: `${START} > out.log 2>&1`, want: ['worker-start'], args: ['--task', 'T-1'] },
  // known limits (pinned): not resolved by design, see the findInvocations doc and README
  { cmd: `$ORCA_BIN orchestration worker-start --task x`, want: [], note: 'KNOWN LIMIT: arbitrary $VAR names are not expanded' },
  { cmd: 'orca$(true) orchestration worker-start --task x', want: [], note: 'KNOWN LIMIT: a substitution glued to the bin hides it' }
]

describe('findInvocations', () => {
  for (const c of CASES) {
    it(`${c.cmd.split('\n')[0].slice(0, 60)}${c.note ? ` — ${c.note}` : ''}`, () => {
      const found = findInvocations(c.cmd)
      assert.deepEqual(found.map((inv) => inv.kind), c.want, c.cmd)
      if (c.args !== undefined) {
        assert.deepEqual(found[0]?.args, c.args, c.cmd)
      }
    })
  }

  let saved: string | undefined
  before(() => {
    saved = process.env.ORCA_CLI_COMMAND
    process.env.ORCA_CLI_COMMAND = '/opt/orca-cli'
  })
  after(() => {
    if (saved === undefined) {
      delete process.env.ORCA_CLI_COMMAND
    } else {
      process.env.ORCA_CLI_COMMAND = saved
    }
  })

  it('matches the literal value of ORCA_CLI_COMMAND', () => {
    assert.deepEqual(findInvocations('/opt/orca-cli orchestration worker-start --task x').map((i) => i.kind), ['worker-start'])
  })
})

describe('findGitHookBypass', () => {
  const blocked = [
    'git commit --no-verify -m x',
    'git commit -n -m x',
    'git commit -anm x',
    'git push --no-verify origin HEAD',
    'git -c core.hooksPath=/dev/null commit -m x',
    'git -C repo -c core.hooksPath=x commit -m y',
    'git config core.hooksPath /tmp/none',
    'git config --local core.hooksPath .nohooks',
    'git config --unset core.hooksPath',
    'cd repo && git commit --no-verify -m x',
    'bash -c "git commit --no-verify -m x"',
    'echo $(git merge --no-verify main)'
  ]
  const allowed = [
    'git commit -m "skip --no-verify talk"',
    'git commit -m x',
    'git push origin HEAD',
    'git push -n origin HEAD',
    'git config core.hooksPath',
    'git config --get core.hooksPath',
    'git log --oneline',
    "echo 'git commit --no-verify'",
    'gitleaks detect --no-verify'
  ]
  for (const cmd of blocked) {
    it(`blocks: ${cmd}`, () => assert.equal(findGitHookBypass(cmd), true))
  }
  for (const cmd of allowed) {
    it(`allows: ${cmd}`, () => assert.equal(findGitHookBypass(cmd), false))
  }
})
