+++
title = "Every Retrieval Is an Authorization Decision: Multi-Tenant RAG Done Safely"
date = 2026-06-22T20:20:00+04:00
draft = false
summary = "In a single-tenant RAG you trust the index. In a multi-tenant one, a shared index plus one missing filter leaks Tenant A's documents into Tenant B's answer. Here is the unified mental model that ties the metadata-filtering mechanics and the authorization layer together, treat the tenant filter as a policy decision, not app code, with the same architecture mapped across AWS, Azure, and Google Cloud (diagrams and Python included)."
tags = ["rag", "security", "aws", "azure", "gcp", "bedrock", "authorization", "ai"]
ShowToc = true
TocOpen = true
+++

> **Framing note.** I have not shipped this exact architecture in production. This is an explainer built on two AWS reference articles (linked at the end), plus my own opinion about where the real risk lives. Treat the code as illustrative, not copy-paste.

## The whole problem in one sentence

In a single-tenant RAG system you trust the index. Everything in it belongs to the one user you are serving, so "retrieve the most relevant chunks" is a safe instruction.

Put two tenants in the same index and that instruction becomes dangerous. "Retrieve the most relevant chunks" now means "retrieve the most relevant chunks from everyone's data," and the only thing standing between Tenant A and Tenant B's confidential documents is a filter you remembered to add. Forget it once, in one code path, and your RAG confidently quotes another customer's contract back to the wrong customer.

That is the entire challenge of multi-tenant RAG. It is not the embeddings, the chunking strategy, or the model. It is the boundary, and where you choose to enforce it.

## The isolation spectrum

There are two honest ways to keep tenants apart, and they trade off against each other.

| | Silo (index per tenant) | Pool (one shared index) |
|---|---|---|
| **Isolation** | Physical. A query physically cannot reach another tenant's index. | Logical. Every query must carry a correct filter. |
| **Cost / scale** | One index, one ingestion pipeline, one set of infra per tenant. Painful past a few dozen. | One of everything. Scales to thousands of tenants cheaply. |
| **Blast radius of a bug** | Small. A missing filter returns nothing, not someone else's data. | Large. A missing filter returns everyone's data. |
| **Noisy-neighbor / ops** | Isolated but heavy. | Shared, so you manage capacity and limits centrally. |

The silo model is the safe default and the reason many teams start there. But it does not scale: a knowledge base, an ingestion job, and a vector index per customer is a lot of moving parts to multiply by ten thousand. So the interesting, and risky, design is the pooled one: a single knowledge base holding every tenant's documents, with a metadata filter applied at retrieval time to scope each query to its tenant. AWS's metadata-filtering article walks through exactly this with Amazon Bedrock Knowledge Bases. Let me describe the mechanics in my own words, then explain why I think the obvious version of it is a footgun.

## The pooled pattern, concretely

In a single Bedrock knowledge base, tenant separation comes down to three things: how you lay out the source data, how you tag it, and how you filter it back out.

**Layout.** Documents land in S3 under a per-tenant prefix, so ownership is obvious from the path and ingestion can scope itself:

```
s3://acme-rag-kb/
  tenant-a/handbook.pdf
  tenant-a/contracts/2026-q2.pdf
  tenant-b/handbook.pdf
```

**Tagging.** A pooled index is only as good as the metadata on each chunk. With Bedrock Knowledge Bases you attach a sidecar `<filename>.metadata.json` next to each document, and those fields become filterable attributes on every chunk derived from it:

```json
{
  "metadataAttributes": {
    "tenant_id": "tenant-a",
    "doc_type": "contract",
    "sensitivity": "confidential"
  }
}
```

**Filtering.** At query time you do not just embed the question and grab the top matches. You constrain the retrieval to the tenant first, and only then rank by similarity. Conceptually:

```jsonc
// Retrieve request: scope to the tenant BEFORE similarity ranking
{
  "retrievalQuery": { "text": "what is our PTO policy?" },
  "retrievalConfiguration": {
    "vectorSearchConfiguration": {
      "filter": { "equals": { "key": "tenant_id", "value": "tenant-a" } }
    }
  }
}
```

You can layer more conditions on the same mechanism: `doc_type`, `sensitivity`, a date range, an `andAll` of several predicates. AWS calls the finer-grained version "field-specific chunking," where you split and tag content so that a single document can expose different fields to different filters. It is genuinely useful. It is also where the danger compounds, because now correctness depends on every chunk being tagged correctly at ingestion *and* every query carrying the right filter at retrieval.

## The reframe: that filter is an access-control check

Here is the shift in thinking that the whole post is built around.

Look at the retrieve request again. The `filter` clause is not a search optimization. It is the line that decides which tenant's data this user is allowed to see. A vector search over a pooled index is a `SELECT` over every tenant's documents, and `filter: tenant_id = "tenant-a"` is the `WHERE` clause that makes it legal. You would never let application code freely decide the `WHERE` clause on a shared customer database and trust that every developer, on every code path, forever, gets it right. A RAG retrieval is the same risk wearing different clothes.

So the question is not "did I add the filter." It is "who is allowed to decide the filter, and can I prove it was applied." Once you see retrieval as an authorization decision, the obvious implementation, building the filter inline in your prompt-assembly code, starts to look like exactly the kind of scattered, untestable access control we stopped writing years ago for databases.

## Put the boundary in policy, not app code

This is where AWS's second article, on Verified Permissions, fits. The idea is to externalize the decision. Instead of your retrieval code hardcoding `tenant_id = currentUser.tenant`, it asks a policy engine a question and gets back a yes or no, plus the constraints to apply.

Amazon Verified Permissions uses Cedar, a small policy language for exactly this. An illustrative policy, written so it is the same shape as what you would actually deploy:

```cedar
// A user may read a knowledge-base document only when the document's
// tenant matches the user's tenant.
permit(
  principal,
  action == Action::"RetrieveDocument",
  resource
)
when {
  resource.tenant_id == principal.tenant_id
};
```

Now the flow inverts. The request arrives with an identity (a JWT from your IdP, say). A thin authorizer, a Lambda in the AWS version, asks Verified Permissions "can this principal perform `RetrieveDocument`, and under what conditions." The decision, and the tenant scope it implies, is what drives the metadata filter. The retrieval code no longer *chooses* the boundary; it *enforces a boundary it was handed.*

Three things get better the moment the boundary lives in policy:

1. **It is auditable.** The rule "a user sees only their tenant's docs" is one readable policy, not an implicit invariant spread across every retrieval call site.
2. **It is testable.** You can unit-test the policy engine with principals and resources and assert allow/deny, without standing up a knowledge base.
3. **It fails closed.** No identity, no decision, no retrieval. A missing filter in app code fails *open* (returns everything); a missing decision from a policy engine returns deny.

## The decision flow, end to end

Stitching both articles together, a single retrieval looks like this:

{{< figure src="decision-flow.svg" alt="A client query with a JWT hits a policy engine, which denies with 403 or allows with a tenant scope; retrieval is filtered to that tenant before the LLM generates a grounded, tenant-scoped answer" caption="Identity becomes a policy decision; the decision becomes the retrieval filter; only then does the model see anything. Deny fails closed." >}}

The two AWS pieces are the two halves of this picture. The metadata-filtering article is everything below the policy engine: how chunks get tagged and filtered in one Bedrock knowledge base. The Verified Permissions article is everything above it: how an identity becomes an allow/deny and a tenant scope. The filter is the seam where they meet, and treating that seam as an authorization decision is what keeps the two halves honest.

## The same shape on three clouds

None of this is AWS-specific. Swap the service names and the architecture is identical on Azure and Google Cloud: an identity becomes a policy decision, the decision yields a tenant scope, and that scope becomes a filter on a managed retrieval call before generation. Here is the equivalence, component by component.

| Component | AWS | Azure | Google Cloud |
|---|---|---|---|
| Identity / IdP | Amazon Cognito | Microsoft Entra ID | Identity Platform |
| API + authorizer | API Gateway + Lambda authorizer | API Management + Functions | API Gateway / Apigee + Cloud Run |
| Policy decision | Verified Permissions (Cedar) | Entra ID groups, or OPA | IAM Conditions, or OPA |
| Managed retrieval | Bedrock Knowledge Bases | Azure AI Search | Vertex AI RAG Engine |
| Tenant filter | metadata `equals` filter | OData `$filter` (security-trim pattern) | schema-based `metadata_filter` |
| Vector store | OpenSearch Serverless / Aurora pgvector | Azure AI Search index | Vertex AI Vector Search |
| Source docs | Amazon S3 | Azure Blob Storage | Google Cloud Storage |
| LLM | Amazon Bedrock | Azure OpenAI | Vertex AI (Gemini) |

### AWS

```
client ─JWT─► API Gateway + Lambda authorizer
                 │
                 ▼
        Verified Permissions (Cedar)  ─deny─► 403
                 │ allow + tenant scope
                 ▼
        Bedrock Knowledge Base .retrieve
        filter: tenant_id = <scope>     ◄── S3 docs + .metadata.json
                 │
                 ▼
        Bedrock (Claude, etc.) ─► grounded answer
```

```python
import boto3

bedrock = boto3.client("bedrock-agent-runtime")

# `tenant` comes from the policy decision, never from user input.
resp = bedrock.retrieve(
    knowledgeBaseId="kb-acme",
    retrievalQuery={"text": question},
    retrievalConfiguration={
        "vectorSearchConfiguration": {
            "filter": {"equals": {"key": "tenant_id", "value": tenant}},
        }
    },
)
```

### Azure

```
client ─JWT─► API Management + Function
                 │  (Microsoft Entra ID + group claims)
                 ▼
        authz decision (Entra groups / OPA)  ─deny─► 403
                 │ allow + tenant scope
                 ▼
        Azure AI Search .search
        $filter: tenant_id eq '<scope>'   ◄── Blob Storage docs
                 │
                 ▼
        Azure OpenAI ─► grounded answer
```

```python
from azure.search.documents import SearchClient
from azure.search.documents.models import VectorizedQuery

client = SearchClient(endpoint, index_name, credential)

# Azure formalizes this as the "security filter pattern": the OData
# filter IS the access check. `tenant` comes from the verified identity.
results = client.search(
    search_text=None,
    vector_queries=[VectorizedQuery(
        vector=embed(question), fields="content_vector", k_nearest_neighbors=5)],
    filter=f"tenant_id eq '{tenant}'",
)
```

### Google Cloud

```
client ─JWT─► API Gateway / Apigee + Cloud Run
                 │  (Identity Platform)
                 ▼
        authz decision (IAM Conditions / OPA)  ─deny─► 403
                 │ allow + tenant scope
                 ▼
        Vertex AI RAG Engine retrieval_query
        metadata_filter: tenant_id == "<scope>"   ◄── GCS docs + schema
                 │
                 ▼
        Vertex AI (Gemini) ─► grounded answer
```

```python
from vertexai import rag

# IMPORTANT: on Vertex, metadata_filter silently does NOTHING unless the
# corpus has a metadata SCHEMA defined first. Define it at ingestion, or
# this "filter" returns everyone's chunks. (More on this below.)
cfg = rag.RagRetrievalConfig(
    top_k=5,
    filter=rag.Filter(metadata_filter=f'tenant_id == "{tenant}"'),
)
contexts = rag.retrieval_query(
    rag_resources=[rag.RagResource(rag_corpus=corpus)],
    text=question,
    rag_retrieval_config=cfg,
)
```

### Where they diverge: who owns the decision

The shape is the same; the difference is whether there is a purpose-built place to put the authorization decision. AWS is the only one of the three with a dedicated, externalized policy engine for application authz (Verified Permissions, speaking Cedar). On Azure and GCP you either lean on the managed search's built-in security filtering, keyed off your IdP's group claims (Azure AI Search's security-trim pattern, Vertex's document ACLs), or you bring your own policy engine such as Open Policy Agent. The thesis does not change with the logo: the tenant filter is the authorization decision. All that moves is who gets to make it, and how easy it is to audit afterward.

## Where it still goes wrong (my take)

Externalizing the policy removes the biggest footgun. It does not remove all of them. The failure modes I would watch:

- **The filter that silently no-ops.** If a query is built with a misspelled key (`tenantId` vs `tenant_id`) or a filter that does not match the indexed attribute name, many vector stores do not error. They just ignore the filter and return unfiltered results. This is not hypothetical: on Vertex AI RAG Engine, the high-level `metadata_filter` silently does nothing unless you defined a metadata schema on the corpus first, so a "filtered" query happily returns every tenant's chunks. Test that a *wrong* filter returns nothing, not that a right one returns something.
- **Ingestion-time mis-tagging.** Policy at retrieval cannot save you if a document was tagged with the wrong `tenant_id`, or with none, at ingestion. The boundary is only as trustworthy as the weakest write into the index. Tag at ingestion from the trusted S3 prefix, never from anything user-supplied, and reject untagged chunks.
- **Field-specific chunking as attack surface.** The more granular your per-field tagging, the more places a single mislabeled chunk leaks. Granularity buys flexibility and costs you correctness guarantees. Add it deliberately.
- **"The model already saw it, so it is fine."** Once a cross-tenant chunk is in the context window, the boundary has already failed. There is no downstream guardrail, no system-prompt instruction, that reliably un-leaks data the model can read. The enforcement has to be at retrieval, before generation, every time.
- **Embeddings are data too.** If you ever expose similarity scores, nearest-neighbor ids, or let one tenant influence another's index, you can leak signal even without returning raw text. Keep the index logic on the server.

The throughline: in multi-tenant RAG, every layer below the policy decision is a place to leak, and the model is the one layer that cannot help you. So you move the decision up front, make it explicit, make it fail closed, and prove it ran.

## Read the originals

This post is my synthesis and opinion. The two AWS reference articles it builds on are worth reading in full for the concrete Bedrock wiring:

- [Secure multi-tenant RAG with Amazon Bedrock and Verified Permissions](https://aws.amazon.com/blogs/architecture/secure-multi-tenant-rag-with-amazon-bedrock-and-verified-permissions/) (AWS Architecture Blog) for the authorization layer.
- [Multi-tenancy in RAG applications in a single Amazon Bedrock knowledge base with metadata filtering](https://aws.amazon.com/blogs/machine-learning/multi-tenancy-in-rag-applications-in-a-single-amazon-bedrock-knowledge-base-with-metadata-filtering/) (AWS Machine Learning Blog) for the metadata-filtering mechanics.

If you are building this, start siloed, move to pooled only when scale forces it, and the day you pool, put the tenant boundary in a policy engine. Future you, reading an incident report, will be grateful.
