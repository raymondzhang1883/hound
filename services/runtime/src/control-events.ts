export function controlEventSummary(event: { type: string; [key: string]: unknown }) {
  const trial = Number(event.trial ?? event.index) + 1;
  const step = Number(event.step) + 1;
  const summaries: Record<string, string> = {
    hunt_started: 'Hunt execution started on fresh owned fixtures',
    trial_started: `Trial ${trial} started`,
    observation: `Trial ${trial} observed isolated actor pages for decision ${step}`,
    provider_completed: `Trial ${trial} model decision ${step} completed`,
    provider_stopped: `Trial ${trial} model stopped with ${String(event.code ?? 'unknown').slice(0, 80)}`,
    decision: `Trial ${trial} decision ${step}: ${String(event.status ?? 'unknown').slice(0, 40)}`,
    suspicion: `Trial ${trial} produced a deterministic suspicion; paired replay will verify it`,
    trial_finished: `Trial ${trial} finished: ${String(event.reason ?? 'complete').slice(0, 80)}`,
    replay_started: `Fresh ${String(event.target ?? 'unknown').slice(0, 20)} replay started`,
    replay_finished: `Fresh ${String(event.target ?? 'unknown').slice(0, 20)} replay finished`,
    hunt_finished: `Hunt finished: ${String((event.result as any)?.outcome ?? 'unknown').slice(0, 80)}`,
  };
  return summaries[event.type];
}
