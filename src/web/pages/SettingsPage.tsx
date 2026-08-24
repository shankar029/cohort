import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { ApprovalMode } from '@shared/index';
import { useApp } from '../state';
import { Banner, ModelSelect } from '../components/ui';

export function SettingsPage(): React.JSX.Element {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const { state, updateProject, deleteProject } = useApp();
  const project = state.projects.find((p) => p.id === projectId);

  const [defaultModel, setDefaultModel] = useState('');
  const [approvalMode, setApprovalMode] = useState<ApprovalMode>('auto-workspace');
  const [extraRoots, setExtraRoots] = useState('');
  const [recordSessions, setRecordSessions] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (project) {
      setDefaultModel(project.settings.defaultModel);
      setApprovalMode(project.settings.approvalMode);
      setExtraRoots(project.settings.extraSkillRoots.join(', '));
      setRecordSessions(project.settings.recordSessions === true);
    }
    // Initialize the form only when switching projects — not on every background
    // project update (WS heartbeats), which would clobber unsaved edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id]);

  if (!project) return <div className="p-6 text-sm text-slate-500">Project not found.</div>;

  const save = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    try {
      await updateProject(project.id, {
        defaultModel,
        approvalMode,
        extraSkillRoots: extraRoots
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        recordSessions,
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    }
  };

  return (
    <div className="h-full overflow-auto">
      <header className="border-b border-surface-border px-6 py-4">
        <h1 className="text-lg font-semibold text-slate-100">Settings</h1>
        <p className="text-sm text-slate-500">Configure how this project's agents run.</p>
      </header>

      <form className="mx-auto max-w-2xl space-y-5 p-6" onSubmit={save}>
        <div>
          <label className="label" htmlFor="s-model">
            Default model (for new agents)
          </label>
          <ModelSelect
            id="s-model"
            testId="settings-model"
            value={defaultModel}
            onChange={setDefaultModel}
          />
        </div>

        <div>
          <span className="label">Tool approval mode</span>
          <div className="space-y-2">
            <label className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name="approval"
                className="mt-1"
                checked={approvalMode === 'auto-workspace'}
                onChange={() => setApprovalMode('auto-workspace')}
              />
              <span>
                <span className="font-medium text-slate-200">Auto-approve within workspace</span>
                <span className="block text-xs text-slate-500">
                  Agents may read/write/run inside the project's repo directory automatically.
                  Writes outside it are blocked.
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name="approval"
                className="mt-1"
                data-testid="approval-manual"
                checked={approvalMode === 'manual'}
                onChange={() => setApprovalMode('manual')}
              />
              <span>
                <span className="font-medium text-slate-200">Ask me every time</span>
                <span className="block text-xs text-slate-500">
                  Every file write and shell command is surfaced to you for approval in the Chat
                  page.
                </span>
              </span>
            </label>
          </div>
        </div>

        <div>
          <label className="label" htmlFor="s-roots">
            Extra skill home roots (comma-separated)
          </label>
          <input
            id="s-roots"
            className="input font-mono text-xs"
            value={extraRoots}
            onChange={(e) => setExtraRoots(e.target.value)}
            placeholder="C:\\Users\\me\\.agents\\skills"
          />
          <p className="mt-1 text-xs text-slate-500">
            Scanned in addition to the built-in home roots and this project's own skill folders.
          </p>
        </div>

        <div>
          <span className="label">Session recording</span>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              data-testid="record-sessions"
              checked={recordSessions}
              onChange={(e) => setRecordSessions(e.target.checked)}
            />
            <span>
              <span className="font-medium text-slate-200">Record all agent sessions</span>
              <span className="block text-xs text-slate-500">
                Captures every agent turn — the full prompt, reasoning, tool calls, and reply — to
                disk so you and the Team Lead can review what happened on the{' '}
                <span className="font-medium">Recordings</span> page. Transcripts may include repo
                content; they stay on this machine and can be cleared anytime.
              </span>
            </span>
          </label>
        </div>

        {error && <Banner kind="error">{error}</Banner>}

        <div className="flex items-center gap-3">
          <button type="submit" className="btn-primary" data-testid="settings-save">
            Save settings
          </button>
          {saved && <span className="text-sm text-status-done">Saved ✓</span>}
        </div>
      </form>

      <div className="mx-auto max-w-2xl border-t border-surface-border p-6">
        <h2 className="mb-2 text-sm font-semibold text-red-300">Danger zone</h2>
        <div className="flex items-center justify-between rounded-lg border border-red-500/30 bg-red-500/5 p-4">
          <div>
            <p className="text-sm font-medium text-slate-200">Delete this project</p>
            <p className="text-xs text-slate-500">
              Removes the team, board, and logs. Your repository files are untouched.
            </p>
          </div>
          <button
            className="btn-danger"
            data-testid="delete-project"
            onClick={() => {
              if (confirm(`Delete project "${project.name}"? This cannot be undone.`)) {
                void deleteProject(project.id).then(() => navigate('/'));
              }
            }}
          >
            Delete project
          </button>
        </div>
      </div>
    </div>
  );
}
