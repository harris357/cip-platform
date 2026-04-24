export async function WorkerOnboardingWorkflow(input: {
  tenantId: string;
  workerId: string;
}): Promise<void> {
  // Workflow ID convention: worker-onboarding-{tenantId}-{workerId}
  void input;
  throw new Error('WorkerOnboardingWorkflow: not implemented');
}
