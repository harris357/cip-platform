import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import express, { type Request, type Response, type NextFunction } from 'express'
import { registerAdminTools } from '../modules/admin/mcp-tools/index.js'
import { registerCertificationTools } from '../modules/certifications/mcp-tools/index.js'
import { registerComplianceTools } from '../modules/compliance/mcp-tools/index.js'
import { registerEmployeeTools } from '../modules/employees/mcp-tools/index.js'
import { registerPeopleTools } from '../modules/people/mcp-tools/index.js'
import { registerSettingsTools } from '../modules/settings/mcp-tools/index.js'
import { getPool } from '../db/index.js'
import { seedPermissionCatalog } from '../services/permission-catalog-seed.js'
import { seedToolEmbeddings } from '../services/tool-embeddings-seed.js'

// Pull the Bearer token off the HTTP request and attach it as req.auth so that
// the MCP transport surfaces it to each tool handler as authInfo.token.
function attachBearerAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization ?? ''
  if (header.startsWith('Bearer ')) {
    const token = header.slice('Bearer '.length).trim()
    if (token) {
      (req as Request & { auth?: { token: string } }).auth = { token }
    }
  }
  next()
}

// Slice 69: per-module MCP endpoints. Each path registers ONLY its module's
// tools. Foundation for multi-agent (Arc 2) — each module is now an
// addressable agent boundary. Legacy /mcp removed (hard cut).
interface ModuleSpec {
  path:     string
  register: (s: McpServer) => void
}

const MODULES: ModuleSpec[] = [
  { path: '/mcp/cert',       register: registerCertificationTools },
  { path: '/mcp/employee',   register: registerEmployeeTools     },
  { path: '/mcp/compliance', register: registerComplianceTools   },
  { path: '/mcp/people',     register: registerPeopleTools       },
  { path: '/mcp/settings',   register: registerSettingsTools     },
  { path: '/mcp/admin',      register: registerAdminTools        },
]

function createModuleServer(register: (s: McpServer) => void): McpServer {
  const s = new McpServer({ name: 'hr-service', version: '1.0.0' })
  register(s)
  return s
}

// Combined server kept ONLY for the tool-embeddings seed (it scans every tool
// once at startup). Not exposed over HTTP.
function createCombinedServerForSeed(): McpServer {
  const s = new McpServer({ name: 'hr-service', version: '1.0.0' })
  registerAdminTools(s)
  registerCertificationTools(s)
  registerComplianceTools(s)
  registerEmployeeTools(s)
  registerPeopleTools(s)
  registerSettingsTools(s)
  return s
}

export const server = createCombinedServerForSeed()

export async function startMcpServer(): Promise<void> {
  try {
    await seedPermissionCatalog(getPool())
  } catch (err) {
    console.warn(`[catalog] seed failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  try {
    await seedToolEmbeddings(server, getPool())
  } catch (err) {
    console.warn(`[tool-embeddings] seed failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  const app = express()
  app.use(express.json())

  for (const mod of MODULES) {
    app.post(mod.path, attachBearerAuth, async (req: Request, res: Response) => {
      const s = createModuleServer(mod.register)
      const transport = new StreamableHTTPServerTransport({})
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await s.connect(transport as any)
      await transport.handleRequest(req, res, req.body)
    })
  }

  // Slice 71b: discovery endpoint. Each service tells the bot what
  // endpoints it exposes. The bot doesn't hardcode this list.
  app.get('/mcp/_modules', (_req: Request, res: Response) => {
    res.json({
      endpoints: MODULES.map(m => ({
        // Path component becomes the ServerName segment after the service prefix.
        name: `hr.${m.path.replace(/^\/mcp\//, '')}`,
        path: m.path,
      })),
    })
  })

  const port = parseInt(process.env['MCP_PORT'] ?? '3001', 10)
  await new Promise<void>((resolve) => {
    app.listen(port, () => {
      console.log(`HR Service MCP Server listening on port ${port}`)
      console.log(`  Modules: ${MODULES.map(m => m.path).join(', ')}`)
      resolve()
    })
  })
}
