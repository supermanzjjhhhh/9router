import { NextResponse } from "next/server";
import { deleteProviderConnectionsByProvider, deleteProviderNode, getProviderConnections, getProviderNodeById, getProviderNodes, updateProviderConnection, updateProviderNode } from "@/models";
import {
  normalizeCompatiblePrefix,
  findEmptyPrefixConflict,
} from "@/shared/utils/compatiblePrefix";

// PUT /api/provider-nodes/[id] - Update provider node
export async function PUT(request, { params }) {
  try {
    const { id } = await params;
    const body = await request.json();
    const { name, prefix, apiType, baseUrl, customHeaders } = body;
    const node = await getProviderNodeById(id);

    if (!node) {
      return NextResponse.json({ error: "Provider node not found" }, { status: 404 });
    }

    if (!name?.trim()) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }

    // Prefix is optional for relay/gateway nodes. Empty = bare upstream model ids.
    const normalizedPrefix = normalizeCompatiblePrefix(prefix);

    if (normalizedPrefix === "") {
      const existing = await getProviderNodes({ type: node.type });
      const conflict = findEmptyPrefixConflict(existing, { type: node.type, excludeId: id });
      if (conflict) {
        return NextResponse.json(
          {
            error: `Only one empty-prefix ${node.type} node is allowed. "${conflict.name || conflict.id}" already uses no prefix. Set a prefix, or clear the other node's prefix first.`,
          },
          { status: 400 }
        );
      }
    }

    // Only validate apiType for OpenAI Compatible nodes
    if (node.type === "openai-compatible" && (!apiType || !["chat", "responses"].includes(apiType))) {
      return NextResponse.json({ error: "Invalid OpenAI compatible API type" }, { status: 400 });
    }

    if (!baseUrl?.trim()) {
      return NextResponse.json({ error: "Base URL is required" }, { status: 400 });
    }

    let sanitizedBaseUrl = baseUrl.trim();
    
    // Sanitize Base URL for Anthropic Compatible
    if (node.type === "anthropic-compatible") {
      sanitizedBaseUrl = sanitizedBaseUrl.replace(/\/$/, "");
      if (sanitizedBaseUrl.endsWith("/messages")) {
        sanitizedBaseUrl = sanitizedBaseUrl.slice(0, -9); // remove /messages
      }
    }

    // Sanitize Base URL for Custom Embedding (strip trailing slash and /embeddings)
    if (node.type === "custom-embedding") {
      sanitizedBaseUrl = sanitizedBaseUrl.replace(/\/$/, "");
      if (sanitizedBaseUrl.endsWith("/embeddings")) {
        sanitizedBaseUrl = sanitizedBaseUrl.slice(0, -"/embeddings".length);
      }
    }

    const updates = {
      name: name.trim(),
      prefix: normalizedPrefix,
      baseUrl: sanitizedBaseUrl,
    };

    if (customHeaders !== undefined) {
      updates.customHeaders = customHeaders && typeof customHeaders === "object" ? customHeaders : null;
    }

    if (node.type === "openai-compatible") {
      updates.apiType = apiType;
    }

    const updated = await updateProviderNode(id, updates);

    const connections = await getProviderConnections({ provider: id });
    await Promise.all(connections.map((connection) => (
      updateProviderConnection(connection.id, {
        providerSpecificData: {
          ...(connection.providerSpecificData || {}),
          prefix: normalizedPrefix,
          apiType: node.type === "openai-compatible" ? apiType : undefined,
          baseUrl: sanitizedBaseUrl,
          nodeName: updated.name,
          ...(updated.customHeaders !== undefined ? { customHeaders: updated.customHeaders || undefined } : {}),
        }
      })
    )));

    return NextResponse.json({ node: updated });
  } catch (error) {
    console.log("Error updating provider node:", error);
    return NextResponse.json({ error: "Failed to update provider node" }, { status: 500 });
  }
}

// DELETE /api/provider-nodes/[id] - Delete provider node and its connections
export async function DELETE(request, { params }) {
  try {
    const { id } = await params;
    const node = await getProviderNodeById(id);

    if (!node) {
      return NextResponse.json({ error: "Provider node not found" }, { status: 404 });
    }

    await deleteProviderConnectionsByProvider(id);
    await deleteProviderNode(id);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.log("Error deleting provider node:", error);
    return NextResponse.json({ error: "Failed to delete provider node" }, { status: 500 });
  }
}
