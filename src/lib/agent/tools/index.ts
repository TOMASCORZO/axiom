/**
 * Tools Index — imports all tool modules to register them,
 * then re-exports the registry API.
 */

// Import modules to trigger registration (side effects)
import './coding';
import './game';
import './map';
import './search';
import './web';
import './multiedit';
import './snapshot';
import './pty';
import './project';
import './interaction';
import './tasks';
import './swarm';
import './terminal';
import './sandbox';
import './integrations';

// Re-export registry API
export { executeTool, getToolSchemas, getToolsForAgent, getAllTools, type ToolContext, type ToolInput } from './registry';
