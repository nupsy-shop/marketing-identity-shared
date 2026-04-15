import type Bull from 'bull';
import { getRuntime } from '../../../../lib/runtime.js';

interface JobResult {
  status: 'completed';
  jobType: string;
}

export default async function emailSend(job: Bull.Job): Promise<JobResult> {
  const { logger } = getRuntime();
  const { tenantId, to, templateId, templateData, replyTo } = job.data;

  if (!to || !templateId) {
    throw new Error('Missing required fields: to, templateId');
  }

  // TODO: Wire to actual email provider (SES, SendGrid, etc.)
  // For now, log the intent — email provider integration is not yet configured.
  logger.info('Email send requested (no provider configured)', {
    jobId: job.id, tenantId, to, templateId, replyTo,
  });

  return { status: 'completed', jobType: 'email_send' };
}
