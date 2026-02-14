# Requirements for Elastic Stack Migration

## 1. Environment Variables
The following environment variables must be added to `.env`:

| Variable | Description | Example |
| :--- | :--- | :--- |
| `ELASTIC_CLOUD_ID` | Cloud ID for Elastic Serverless | `Argus:YXNpYS1zb3V0aDEuZ2NwLmVsYXN0aWMtY2xvdWQuY29tOjQ0MyQzZWRlOTZmZTZkZTA0OTU2YmFkMjcyYWI2ZGYxNDM2YiRlODA0ZjgwYjRkMWY0YmQ5YTcyZTA5OThmODZkMjMwNQ==` |
| `ELASTIC_API_KEY` | API Key for authentication | `VkxwUVhwd0Jna2ZPWGNxbVN6ZmM6YTgwM2N3VXMzY05tSGh1dGJ2N3Uwdw==` |
| `ELASTIC_MCP_URL` | URL for Agent Builder MCP | `https://argus-b36107.kb.asia-south1.gcp.elastic-cloud.com/api/agent_builder/mcp` |

## 2. Dependencies
New Node.js packages required:

*   `@elastic/elasticsearch`: Official client for Elasticsearch.
*   `@modelcontextprotocol/sdk` (Optional): If we decide to use MCP directly in Node.

## 3. Infrastructure
*   **Elastic Serverless Project**: Access to an Elastic Cloud Serverless project (Search or Observability type).
*   **Agent Builder**: Enabled in the Elastic project to manage agents and tools.

## 4. Data Migration Strategy
*   **Strategy**: "Fresh Start". We will not migrate existing SQLite data (`events.db`) to Elasticsearch initially.
*   **Reason**: Schema differences and simplicity for the hackathon. Old events will be lost unless a custom script is written.

## 5. Feature Parity Checklist
Ensure these features work with the new backend:
*   [ ] **Ingestion**: Storing WhatsApp messages.
*   [ ] **Event Extraction**: Creating event documents.
*   [ ] **Duplicate Detection**: Fuzzy matching titles to prevent duplicates.
*   [ ] **Context Matching**: Finding events by URL/location keywords (Hybrid Search).
*   [ ] **CRUD**: Updating status (snooze, complete) by ID.
