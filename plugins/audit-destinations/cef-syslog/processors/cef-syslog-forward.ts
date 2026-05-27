import { formatBatch, sendBatch } from '../client.js';
import { createForwardProcessor } from '../../common/forward-batch.js';

export default createForwardProcessor('cef_syslog_forward_batch', { formatBatch, sendBatch });
