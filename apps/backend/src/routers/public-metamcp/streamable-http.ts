import { randomUUID } from "node:crypto";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { DatabaseEndpoint } from "@repo/zod-types";
import express from "express";

import { ApiKeysRepository } from "../../db/repositories/api-keys.repo";
import { endpointsRepository } from "../../db/repositories/endpoints.repo";
import { metaMcpServerPool } from "../../lib/metamcp/metamcp-server-pool";

// Extend Express Request interface for our custom properties
interface AuthenticatedRequest extends express.Request {
  namespaceUuid: string;
  endpointName: string;
  endpoint: DatabaseEndpoint;
  apiKeyUserId?: string;
  apiKeyUuid?: string;
}

const streamableHttpRouter = express.Router();
const apiKeysRepository = new ApiKeysRepository();

const transports: Record<string, StreamableHTTPServerTransport> = {}; // Web app transports by sessionId

// Cleanup function for a specific session
const cleanupSession = async (sessionId: string) => {
  console.log(`Cleaning up StreamableHTTP session ${sessionId}`);

  // Clean up transport
  const transport = transports[sessionId];
  if (transport) {
    delete transports[sessionId];
    await transport.close();
  }

  // Clean up MetaMCP server pool session
  await metaMcpServerPool.cleanupSession(sessionId);
};

// Middleware to lookup endpoint by name and add namespace info to request
const lookupEndpoint = async (
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) => {
  const endpointName = req.params.endpoint_name;

  try {
    const endpoint = await endpointsRepository.findByName(endpointName);
    if (!endpoint) {
      return res.status(404).json({
        error: "Endpoint not found",
        message: `No endpoint found with name: ${endpointName}`,
      });
    }

    // Add the endpoint info to the request for use in handlers
    const authReq = req as AuthenticatedRequest;
    authReq.namespaceUuid = endpoint.namespace_uuid;
    authReq.endpointName = endpointName;
    authReq.endpoint = endpoint;

    next();
  } catch (error) {
    console.error("Error looking up endpoint:", error);
    return res.status(500).json({
      error: "Internal server error",
      message: "Failed to lookup endpoint",
    });
  }
};

// API Key authentication middleware
const authenticateApiKey = async (
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) => {
  const authReq = req as AuthenticatedRequest;
  const endpoint = authReq.endpoint;

  // Skip authentication if not enabled for this endpoint
  if (!endpoint?.enable_api_key_auth) {
    return next();
  }

  try {
    let apiKey: string | undefined;

    // Always check headers first (Authorization: Bearer <key> or X-API-Key: <key>)
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith("Bearer ")) {
      apiKey = authHeader.substring(7);
    } else {
      apiKey = req.headers["x-api-key"] as string;
    }

    // If no API key in headers and query param auth is enabled, check query parameters
    if (!apiKey && endpoint.use_query_param_auth) {
      apiKey = (req.query.api_key as string) || (req.query.apikey as string);
    }

    if (!apiKey) {
      const authMethods = [
        "Authorization header (Bearer token)",
        "X-API-Key header",
      ];
      if (endpoint.use_query_param_auth) {
        authMethods.push("query parameter (api_key or apikey)");
      }

      return res.status(401).json({
        error: "Authentication required",
        message: `API key required in one of: ${authMethods.join(", ")}`,
      });
    }

    // Validate the API key
    const validation = await apiKeysRepository.validateApiKey(apiKey);
    if (!validation.valid) {
      return res.status(401).json({
        error: "Invalid API key",
        message: "The provided API key is invalid or inactive",
      });
    }

    // Add user info to request for potential logging/auditing
    authReq.apiKeyUserId = validation.user_id;
    authReq.apiKeyUuid = validation.key_uuid;

    next();
  } catch (error) {
    console.error("Error validating API key:", error);
    return res.status(500).json({
      error: "Internal server error",
      message: "Failed to validate API key",
    });
  }
};

streamableHttpRouter.get(
  "/:endpoint_name/mcp",
  lookupEndpoint,
  authenticateApiKey,
  async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    const { namespaceUuid, endpointName } = authReq;
    const sessionId = req.headers["mcp-session-id"] as string;

    // console.log(
    //   `Received GET message for public endpoint ${endpointName} -> namespace ${namespaceUuid} sessionId ${sessionId}`,
    // );

    try {
      const transport = transports[sessionId];
      if (!transport) {
        res.status(404).end("Session not found");
        return;
      } else {
        await transport.handleRequest(req, res);
      }
    } catch (error) {
      console.error("Error in public endpoint /mcp route:", error);
      res.status(500).json(error);
    }
  },
);

streamableHttpRouter.post(
  "/:endpoint_name/mcp",
  lookupEndpoint,
  authenticateApiKey,
  async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    const { namespaceUuid, endpointName } = authReq;
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (!sessionId) {
      try {
        console.log(
          `New public endpoint StreamableHttp connection request for ${endpointName} -> namespace ${namespaceUuid}`,
        );

        // Generate session ID upfront
        const newSessionId = randomUUID();

        // Get or create MetaMCP server instance from the pool
        const mcpServerInstance = await metaMcpServerPool.getServer(
          newSessionId,
          namespaceUuid,
        );
        if (!mcpServerInstance) {
          throw new Error("Failed to get MetaMCP server instance from pool");
        }

        console.log(
          `Using MetaMCP server instance for public endpoint session ${newSessionId} (endpoint: ${endpointName})`,
        );

        // Create transport with the predetermined session ID
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => newSessionId,
          onsessioninitialized: async (sessionId) => {
            try {
              console.log(`Session initialized for sessionId: ${sessionId}`);
            } catch (error) {
              console.error(
                `Error initializing public endpoint session ${sessionId}:`,
                error,
              );
            }
          },
        });

        // Note: Cleanup is handled explicitly via DELETE requests
        // StreamableHTTP is designed to persist across multiple requests
        console.log("Created public endpoint StreamableHttp transport");

        // Store transport reference
        transports[newSessionId] = transport;

        console.log(
          `Public Endpoint Client <-> Proxy sessionId: ${newSessionId} for endpoint ${endpointName} -> namespace ${namespaceUuid}`,
        );
        console.log(`Stored transport for sessionId: ${newSessionId}`);
        console.log(`Current stored sessions:`, Object.keys(transports));

        // Connect the server to the transport before handling the request
        await mcpServerInstance.server.connect(transport);

        // Now handle the request - server is guaranteed to be ready
        await transport.handleRequest(req, res, req.body);
      } catch (error) {
        console.error("Error in public endpoint /mcp POST route:", error);
        res.status(500).json(error);
      }
    } else {
      // console.log(
      //   `Received POST message for public endpoint ${endpointName} -> namespace ${namespaceUuid} sessionId ${sessionId}`,
      // );
      console.log(`Available session IDs:`, Object.keys(transports));
      console.log(`Looking for sessionId: ${sessionId}`);
      try {
        const transport = transports[sessionId];
        if (!transport) {
          console.error(
            `Transport not found for sessionId ${sessionId}. Available sessions:`,
            Object.keys(transports),
          );
          res.status(404).end("Transport not found for sessionId " + sessionId);
        } else {
          await transport.handleRequest(req, res, req.body);
        }
      } catch (error) {
        console.error("Error in public endpoint /mcp route:", error);
        res.status(500).json(error);
      }
    }
  },
);

streamableHttpRouter.delete(
  "/:endpoint_name/mcp",
  lookupEndpoint,
  authenticateApiKey,
  async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    const { namespaceUuid, endpointName } = authReq;
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    console.log(
      `Received DELETE message for public endpoint ${endpointName} -> namespace ${namespaceUuid} sessionId ${sessionId}`,
    );

    if (sessionId) {
      try {
        await cleanupSession(sessionId);
        console.log(
          `Public endpoint session ${sessionId} cleaned up successfully`,
        );
        res.status(200).end();
      } catch (error) {
        console.error("Error in public endpoint /mcp DELETE route:", error);
        res.status(500).json(error);
      }
    } else {
      res.status(400).end("Missing sessionId");
    }
  },
);

export default streamableHttpRouter;
