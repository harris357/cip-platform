# Slice 00-INFRA — Platform Readiness
## Getting Every External Service Wired, Configured, and Verified Before Writing Code

> **Session type:** Manual setup + verification. No application code.  
> **When:** Complete this entire slice before Slice 01. Every section must reach ✅ before you move on.  
> **Output:** A filled `.envrc` file, all K8s secrets created, and every verification command passing.  
> **Reference docs:** `CIP_Integration_Wiring_v0_2.docx` (full wiring details), `CIP_Platform_Architecture_v1_0.docx` (architectural rationale)

---

## Overview — What This Slice Covers

This slice works through every external cloud service the platform touches, in dependency order. Each section has three parts:
1. **Account / credential setup** — where to go, what to create, what to copy
2. **Where the credential lives** — `.envrc` variable, K8s Secret name, ConfigMap key
3. **Verification command** — how to confirm the connection works before moving on

Complete the sections in order. Later sections depend on earlier ones (e.g. Cloudflare DNS must be live before cert-manager can issue TLS certificates; TLS must work before Keycloak is publicly reachable).

---

## Credential Master Checklist

Fill this in as you work through each section. Every row must be ✅ before starting Slice 01.

| Credential | Where it lives | Status |
|------------|---------------|--------|
| OVH account + project ID | `.envrc` → `OVH_PROJECT_ID` | ☐ |
| OVH API key + secret + consumer key | `.envrc` → `OVH_APP_KEY` / `OVH_APP_SECRET` / `OVH_CONSUMER_KEY` | ☐ |
| OVH Kubernetes cluster ID | `.envrc` → `OVH_CLUSTER_ID` | ☐ |
| OVH node pool ID | `.envrc` → `OVH_NODEPOOL_ID` | ☐ |
| OVH kubeconfig downloaded | `~/.kube/cip-dev.yaml` | ☐ |
| OVH S3 access key + secret | `.envrc` → `OVH_S3_ACCESS_KEY` / `OVH_S3_SECRET_KEY` | ☐ |
| OVH Object Store endpoint | `.envrc` → `AWS_ENDPOINT_URL` | ☐ |
| Cloudflare account ID | `.envrc` → `CF_ACCOUNT_ID` | ☐ |
| Cloudflare zone ID for cip.io | `.envrc` → `CF_ZONE_ID` | ☐ |
| Cloudflare API token (DNS:Edit scope) | `.envrc` → `CLOUDFLARE_API_TOKEN` | ☐ |
| Domain registered and pointing to Cloudflare nameservers | Cloudflare dashboard | ☐ |
| All DNS A records created (proxied) | Cloudflare DNS | ☐ |
| Cloudflare SSL mode set to Full (Strict) | Cloudflare SSL/TLS | ☐ |
| OVH LB IP allowlist configured (Cloudflare IPs only) | OVH LB / Nginx Ingress | ☐ |
| Temporal Cloud account created | cloud.temporal.io | ☐ |
| Temporal namespace created | `.envrc` → `TEMPORAL_NAMESPACE` | ☐ |
| Temporal API key created and stored | `.envrc` → `TEMPORAL_API_KEY` | ☐ |
| Temporal namespace address noted | `.envrc` → `TEMPORAL_ADDRESS` | ☐ |
| Langfuse Cloud account created | cloud.langfuse.com | ☐ |
| Langfuse public key copied | `.envrc` → `LANGFUSE_PUBLIC_KEY` | ☐ |
| Langfuse secret key copied | `.envrc` → `LANGFUSE_SECRET_KEY` | ☐ |
| Langfuse host set | `.envrc` → `LANGFUSE_HOST` | ☐ |
| Anthropic API key created | `.envrc` → `ANTHROPIC_API_KEY` | ☐ |
| PostgreSQL password set | `.envrc` → `PG_ADMIN_PASSWORD` / `PG_USER_PASSWORD` | ☐ |
| Keycloak admin password set | `.envrc` → `KEYCLOAK_ADMIN_PASSWORD` | ☐ |
| LiteLLM master key generated | `.envrc` → `LITELLM_MASTER_KEY` | ☐ |
| Twilio account SID + auth token | `.envrc` → `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` | ☐ |
| Twilio phone number | `.envrc` → `TWILIO_PHONE_NUMBER` | ☐ |
| Resend API key | `.envrc` → `RESEND_API_KEY` | ☐ |
| Azure Bot Service app ID + password | `.envrc` → `BOT_APP_ID` / `BOT_APP_PASSWORD` | ☐ |
| All K8s secrets created | `kubectl get secrets -A` | ☐ |
| LiteLLM health check passes | `curl /health/liveliness` | ☐ |
| Temporal worker polls successfully | Temporal Cloud UI | ☐ |
| Langfuse traces arriving | cloud.langfuse.com → Traces | ☐ |
| JWT contains tenantId claim | `echo $TOKEN | cut -d'.' -f2 | base64 -d | jq .tenantId` | ☐ |

---

## Section 1 — OVH Public Cloud

### 1.1 Account Setup

1. Log in at **ca.ovhcloud.com** (Canadian account) or create one
2. Navigate to: **Public Cloud → Create a new project** → name it `cip-dev`
3. Note your **Project ID** (visible in the URL and on the project overview page): `xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`

```bash
# Add to .envrc
export OVH_PROJECT_ID="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

### 1.2 OVH API Credentials (for node scaling scripts)

The infra scripts in `packages/infra/src/` use the OVH API to scale the node pool. You need three credentials.

1. Go to **eu.api.ovh.com/createToken** (or **ca.api.ovh.com/createToken** for Canadian)
2. Fill in:
   - **Application name:** `cip-infra-scripts`
   - **Application description:** `CIP node pool scaling scripts`
   - **Validity:** Unlimited
   - **Rights:** `GET`, `PUT`, `POST` on `/cloud/project/*`
3. Copy the three values shown:

```bash
# Add to .envrc
export OVH_APP_KEY="xxxxxxxxxxxxxxxx"
export OVH_APP_SECRET="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
export OVH_CONSUMER_KEY="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
export OVH_ENDPOINT="ovh-ca"   # or ovh-eu depending on your account region
```

### 1.3 Kubernetes Cluster

1. **Public Cloud → Managed Kubernetes Service → Create a cluster**
   - **Name:** `cip-dev`
   - **Region:** `BHS` (Beauharnois, Canada) — keep data in Canada
   - **Version:** Latest stable (1.29+)
   - **Node pool name:** `app-pool`
   - **Node type:** `B2-7` (2 vCPU / 7 GB) for dev — upgrade to `B2-15` for PoC proper
   - **Min nodes:** 0, **Max nodes:** 1, **Desired:** 1
   - **Enable autoscaling:** Yes

2. After cluster creation, **download the kubeconfig**:
   - Managed Kubernetes → your cluster → **Service → Download kubeconfig** → save as `~/.kube/cip-dev.yaml`

3. Note your cluster ID and node pool ID (visible in the URL on the cluster page):

```bash
# Add to .envrc
export OVH_CLUSTER_ID="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
export OVH_NODEPOOL_ID="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
export KUBECONFIG="$HOME/.kube/cip-dev.yaml"
```

**Verification:**
```bash
kubectl get nodes
# Expected: one node in Ready state
kubectl get namespaces
# Expected: default, kube-system, kube-public
```

### 1.4 Create Namespaces

```bash
kubectl apply -f infra/k8s/namespaces.yaml
kubectl get namespaces
# Expected: cip-app and cip-infra now appear
```

### 1.5 OVH Object Store

1. **Public Cloud → Object Storage → Create an object container**
   - **Region:** BHS
   - **Solution type:** Standard (S3 API)
   - **Container name:** `cip-dev-documents` (you will create per-tenant buckets later via TenantProvisioningWorkflow)

2. **Create S3 credentials:**
   - Object Storage → S3 Users → **Add a user**
   - **Name:** `cip-dev-service`
   - After creation, click **Generate S3 credentials** → copy both keys immediately

```bash
# Add to .envrc
export OVH_S3_ACCESS_KEY="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
export OVH_S3_SECRET_KEY="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
export AWS_ENDPOINT_URL="https://s3.bhs.io.cloud.ovh.net"
export AWS_REGION="BHS"
export AWS_ACCESS_KEY_ID="$OVH_S3_ACCESS_KEY"
export AWS_SECRET_ACCESS_KEY="$OVH_S3_SECRET_KEY"
```

**Verification:**
```bash
aws s3 ls --endpoint-url "$AWS_ENDPOINT_URL"
# Expected: list of your buckets (empty or showing cip-dev-documents)
```

---

## Section 2 — Cloudflare

Cloudflare must be set up **before** deploying Keycloak, the platform API, or any other publicly reachable service. cert-manager uses Cloudflare DNS for TLS certificate issuance.

### 2.1 Account and Domain

1. Log in at **dash.cloudflare.com** or create a free account
2. **Add a site** → enter your domain (e.g. `cip.io` or your own domain)
3. Choose **Free plan** (upgrade to **Pro** at PoC time for WAF + rate limiting)
4. Cloudflare will show you **two nameservers** — update your domain registrar to use these
5. Wait for DNS propagation (usually 5–30 minutes; Cloudflare shows "Active" when done)

```bash
# Add to .envrc — find these in the Cloudflare dashboard
export CF_ZONE_ID="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"    # cip.io → Overview → right sidebar
export CF_ACCOUNT_ID="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" # My Profile → Account ID
```

### 2.2 API Token — Least Privilege

1. **My Profile → API Tokens → Create Token → Custom Token**
2. **Token name:** `cip-dev-cert-manager`
3. **Permissions:**
   - Zone → DNS → Edit
   - Zone → Zone → Read
4. **Zone Resources:** Include → Specific Zone → `cip.io`
5. Copy the token immediately — shown only once

```bash
# Add to .envrc
export CLOUDFLARE_API_TOKEN="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

**Verify the token works:**
```bash
curl -s https://api.cloudflare.com/client/v4/user/tokens/verify \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" | jq .result.status
# Expected: "active"
```

### 2.3 DNS Records

Create these A records in Cloudflare DNS, all pointing to your OVH Load Balancer IP. The LB IP is available after deploying the Nginx Ingress Controller (Section 6). **You must deploy the LB first, then come back and fill in the IP.**

Placeholder steps (fill in IP after Section 6):

| Subdomain | Type | Value | Proxy |
|-----------|------|-------|-------|
| `api.dev.cip.io` | A | `<OVH_LB_IP>` | Proxied ✓ |
| `app.dev.cip.io` | A | `<OVH_LB_IP>` | Proxied ✓ |
| `keycloak.dev.cip.io` | A | `<OVH_LB_IP>` | Proxied ✓ |
| `grafana.dev.cip.io` | A | `<OVH_LB_IP>` | Proxied ✓ |
| `nats.dev.cip.io` | A | `<OVH_LB_IP>` | DNS only ✗ |

```bash
# Add to .envrc once you know the LB IP
export OVH_LB_IP="xxx.xxx.xxx.xxx"
```

**Create records via API (run after you have the LB IP):**
```bash
for subdomain in api app keycloak grafana; do
  curl -s -X POST "https://api.cloudflare.com/client/v4/zones/$CF_ZONE_ID/dns_records" \
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"type\":\"A\",\"name\":\"${subdomain}.dev.cip.io\",\"content\":\"$OVH_LB_IP\",\"proxied\":true}" \
    | jq '{name: .result.name, proxied: .result.proxied}'
done
```

### 2.4 SSL/TLS Mode — Full (Strict)

```bash
curl -s -X PATCH "https://api.cloudflare.com/client/v4/zones/$CF_ZONE_ID/settings/ssl" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"value": "strict"}' | jq .result.value
# Expected: "strict"
```

### 2.5 OVH Load Balancer IP Allowlist

This is a hard security requirement. Apply via Nginx Ingress Helm values (add to `infra/helm/nginx-ingress-values.yaml`):

```yaml
# infra/helm/nginx-ingress-values.yaml
controller:
  config:
    use-forwarded-headers: "true"
    real-ip-header: "CF-Connecting-IP"
    set-real-ip-from: |
      173.245.48.0/20,103.21.244.0/22,103.22.200.0/22,103.31.4.0/22,
      141.101.64.0/18,108.162.192.0/18,190.93.240.0/20,188.114.96.0/20,
      197.234.240.0/22,198.41.128.0/17,162.158.0.0/15,104.16.0.0/13,
      104.24.0.0/14,172.64.0.0/13,131.0.72.0/22
```

**Verification:**
```bash
# After Nginx is deployed, confirm CF-Connecting-IP is being set
kubectl logs -n ingress-nginx -l app.kubernetes.io/name=ingress-nginx | grep "CF-Connecting-IP"
```

### 2.6 Cloudflare Access for Grafana

```bash
# Via Zero Trust Dashboard (zero-trust.cloudflare.com):
# Access → Applications → Add application → Self-hosted
#   Domain: grafana.dev.cip.io
#   Policy: Allow → Emails ending in @yourcompany.com
#   Session duration: 8 hours
```

---

## Section 3 — Temporal Cloud

### 3.1 Account and Namespace Setup

1. Go to **cloud.temporal.io** → Sign up (free — includes $1,000 credits for new accounts)
2. **Settings → Namespaces → Create namespace**
   - **Name:** `cip-dev-00000000-0000-0000-0000-000000000001`
   - **Region:** `aws-us-east-2` (or `us-east-1` — closest to BHS, Canada)
   - **Retention:** 3 days (sufficient for dev; extend at PoC)
3. After creation, on the namespace detail page, copy the **namespace address** — format: `<namespace>.<account>.tmprl.cloud:7233`

```bash
# Add to .envrc
export TEMPORAL_NAMESPACE="cip-dev-00000000-0000-0000-0000-000000000001"
export TEMPORAL_ADDRESS="cip-dev-00000000-0000-0000-0000-000000000001.abc12.tmprl.cloud:7233"
# Replace abc12 with your actual account ID from the address shown in the UI
```

### 3.2 API Key

1. **Settings → API Keys → Create API Key**
   - **Name:** `cip-dev-worker`
   - **Expiry:** 1 year (set a calendar reminder to rotate)
2. **Copy the key immediately — it is only shown once**

```bash
# Add to .envrc
export TEMPORAL_API_KEY="<your-temporal-api-key>"
```

**⚡ If you lose this key before storing it, create a new one. Do not proceed without it.**

### 3.3 Temporal CLI Verification

```bash
# Install Temporal CLI if not already installed
brew install temporal   # or: curl -sSf https://temporal.download/cli.sh | sh

# Test connectivity
export TEMPORAL_ADDRESS="$TEMPORAL_ADDRESS"
export TEMPORAL_API_KEY="$TEMPORAL_API_KEY"
export TEMPORAL_NAMESPACE="$TEMPORAL_NAMESPACE"

temporal operator namespace list
# Expected: lists your namespace including cip-dev-00000000-0000-0000-0000-000000000001

temporal workflow list --namespace "$TEMPORAL_NAMESPACE"
# Expected: empty list (no workflows yet) — not an error
```

### 3.4 Task Queues

```bash
# Add to .envrc — these are not secrets, just config
export TEMPORAL_TASK_QUEUE_HR="cip-hr-tasks"
export TEMPORAL_TASK_QUEUE_PLATFORM="cip-platform-tasks"
```

---

## Section 4 — Langfuse Cloud

### 4.1 Account and Project Setup

1. Go to **cloud.langfuse.com** → Sign up with GitHub or email (Hobby plan — free, no credit card)
2. **Create an organisation** → name it `cip`
3. **Create a project** → name it `cip-dev`
4. **Settings → API Keys → Create new API keys** → copy both keys immediately:
   - **Public Key** (prefix: `pk-lf-`) — safe to log, not a secret
   - **Secret Key** (prefix: `sk-lf-`) — never log, treat as a password
5. Note the **host**: `https://cloud.langfuse.com` (EU) — if Canadian data residency matters, use `https://us.cloud.langfuse.com`

```bash
# Add to .envrc
export LANGFUSE_PUBLIC_KEY="pk-lf-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
export LANGFUSE_SECRET_KEY="sk-lf-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
export LANGFUSE_HOST="https://cloud.langfuse.com"
```

**⚠ Data residency note:** The EU region (`cloud.langfuse.com`) is the default. For a PoC with synthetic test data this is acceptable. Switch to `us.cloud.langfuse.com` or self-hosted Langfuse before processing any real client certification documents.

### 4.2 Verification

```bash
curl -s "https://cloud.langfuse.com/api/public/health" \
  -u "$LANGFUSE_PUBLIC_KEY:$LANGFUSE_SECRET_KEY" | jq .status
# Expected: "OK"
```

---

## Section 5 — Anthropic API

### 5.1 API Key Setup

1. Go to **console.anthropic.com → API Keys → Create Key**
   - **Name:** `cip-litellm` (this key is held ONLY by the LiteLLM pod — never by domain services)
   - **Workspace:** create a `cip-dev` workspace if not already present
2. Set a **spending limit** on the workspace: suggested $150 CAD/month for dev
3. Copy the key immediately

```bash
# Add to .envrc — this variable is ONLY mounted on the LiteLLM pod
# It must NEVER appear in domain service environment variables
export ANTHROPIC_API_KEY="sk-ant-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

**⚠ Hard rule:** `ANTHROPIC_API_KEY` is injected only into the `litellm-credentials` K8s secret and mounted only on the LiteLLM pod. Confirm this in the Helm values for `hr-service`, `platform-core`, and `teams-bot` — none of them should have `ANTHROPIC_API_KEY` in their env section.

---

## Section 6 — Internal Passwords and Generated Keys

These are credentials you generate and own — not issued by an external service.

### 6.1 PostgreSQL Passwords

```bash
# Generate strong passwords
export PG_ADMIN_PASSWORD="$(openssl rand -base64 32 | tr -d '=+/' | head -c 32)"
export PG_USER_PASSWORD="$(openssl rand -base64 32 | tr -d '=+/' | head -c 32)"

# Add both to .envrc
echo "export PG_ADMIN_PASSWORD='$PG_ADMIN_PASSWORD'" >> .envrc
echo "export PG_USER_PASSWORD='$PG_USER_PASSWORD'" >> .envrc
```

**Database URL construction** (add to `.envrc` after PG is deployed):
```bash
export DATABASE_URL_HR="postgresql://cipuser:${PG_USER_PASSWORD}@postgres-postgresql.cip-infra:5432/cip_hr"
export DATABASE_URL_PLATFORM="postgresql://cipuser:${PG_USER_PASSWORD}@postgres-postgresql.cip-infra:5432/cip_platform"
export DATABASE_URL_LITELLM="postgresql://cipuser:${PG_USER_PASSWORD}@postgres-postgresql.cip-infra:5432/cip_litellm"
```

### 6.2 Keycloak Admin Password

```bash
export KEYCLOAK_ADMIN_PASSWORD="$(openssl rand -base64 32 | tr -d '=+/' | head -c 32)"
echo "export KEYCLOAK_ADMIN_PASSWORD='$KEYCLOAK_ADMIN_PASSWORD'" >> .envrc

# Keycloak config
export KEYCLOAK_URL="https://keycloak.dev.cip.io"
export KEYCLOAK_REALM="cip-dev"
export KEYCLOAK_CLIENT_ID="platform-api"
export DEV_TENANT_ID="00000000-0000-0000-0000-000000000001"
```

### 6.3 LiteLLM Master Key

The master key is what you use to call the LiteLLM Admin API (issuing virtual keys, checking budgets). It must start with `sk-`.

```bash
export LITELLM_MASTER_KEY="sk-cip-master-$(openssl rand -hex 16)"
echo "export LITELLM_MASTER_KEY='$LITELLM_MASTER_KEY'" >> .envrc

export LITELLM_BASE_URL="http://litellm.cip-app.svc.cluster.local:4000"
export LITELLM_VIRTUAL_KEY="sk-"   # placeholder — filled in after LiteLLM issues the dev tenant key
```

---

## Section 7 — Twilio (SMS)

### 7.1 Account Setup

1. Go to **twilio.com** → Sign up (free trial includes $15 credit)
2. **Console → Phone Numbers → Manage → Buy a Number**
   - Country: Canada
   - Capabilities: SMS ✓
   - Number type: Long code
3. Copy the number (format: `+1xxxxxxxxxx`)
4. **Console → Account → API keys & tokens** → copy the Account SID and Auth Token

```bash
# Add to .envrc
export TWILIO_ACCOUNT_SID="ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
export TWILIO_AUTH_TOKEN="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
export TWILIO_PHONE_NUMBER="+1xxxxxxxxxx"
```

**Test the number (optional):**
```bash
curl -s -X POST "https://api.twilio.com/2010-04-01/Accounts/$TWILIO_ACCOUNT_SID/Messages.json" \
  -u "$TWILIO_ACCOUNT_SID:$TWILIO_AUTH_TOKEN" \
  --data-urlencode "From=$TWILIO_PHONE_NUMBER" \
  --data-urlencode "To=+1<your-number>" \
  --data-urlencode "Body=CIP platform test SMS - setup verification" | jq .sid
# Expected: SMS SID starting with SM
```

---

## Section 8 — Resend (Email)

### 8.1 Account and DNS Setup

1. Go to **resend.com** → Sign up (Hobby plan — 3,000 emails/month free)
2. **Domains → Add Domain** → enter your sending domain (e.g. `notifications.cip.io`)
3. Resend will show DNS records to add — add them in Cloudflare:
   - SPF TXT record
   - DKIM CNAME records (usually 3)
   - DMARC TXT record (optional but strongly recommended)
4. After DNS propagates, Resend shows the domain as **Verified**
5. **API Keys → Create API Key** → name it `cip-dev` → copy immediately

```bash
# Add to .envrc
export RESEND_API_KEY="re_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
export RESEND_FROM_EMAIL="notifications@cip.io"   # or your verified domain
```

**Verification:**
```bash
curl -s -X POST "https://api.resend.com/emails" \
  -H "Authorization: Bearer $RESEND_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"from\":\"$RESEND_FROM_EMAIL\",\"to\":[\"you@yourcompany.com\"],\"subject\":\"CIP setup test\",\"text\":\"Platform readiness test\"}" | jq .id
# Expected: email ID string
```

---

## Section 9 — Azure Bot Service (Teams Channel)

### 9.1 Registration

1. Go to **portal.azure.com** → Create a resource → search **Azure Bot**
2. **Create**:
   - **Bot handle:** `cip-dev-bot`
   - **Subscription:** your Azure sub (free)
   - **Resource group:** `cip-dev-rg`
   - **Pricing tier:** F0 (Free — 10,000 messages/month)
   - **Microsoft App ID:** Create new Microsoft App ID
3. After creation: **Configuration → Messaging endpoint** → set to your Teams Bot URL: `https://api.dev.cip.io/teams/messages`
4. **Configuration → Manage Password** → Create a new client secret → copy immediately

```bash
# Add to .envrc
export BOT_APP_ID="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"   # Microsoft App ID (GUID)
export BOT_APP_PASSWORD="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" # Client secret
```

### 9.2 Teams Channel Registration

1. **Channels → Add a featured channel → Microsoft Teams**
2. Accept the terms → Save
3. The bot is now registered with Teams but not deployed — deployment happens after Slice 11

---

## Section 10 — Kubernetes Secrets (Create All at Once)

With all credentials in `.envrc`, create all K8s secrets now. The `create-secrets.sh` script (Slice 13) will do this automatically — but for the first time, run the commands manually to verify each one.

```bash
# Load all env vars
source .envrc

# 1. Temporal
kubectl create secret generic temporal-credentials \
  --namespace cip-app \
  --from-literal=address="$TEMPORAL_ADDRESS" \
  --from-literal=namespace="$TEMPORAL_NAMESPACE" \
  --from-literal=api-key="$TEMPORAL_API_KEY" \
  --dry-run=client -o yaml | kubectl apply -f -

# 2. Langfuse
kubectl create secret generic langfuse-credentials \
  --namespace cip-app \
  --from-literal=public-key="$LANGFUSE_PUBLIC_KEY" \
  --from-literal=secret-key="$LANGFUSE_SECRET_KEY" \
  --from-literal=host="$LANGFUSE_HOST" \
  --dry-run=client -o yaml | kubectl apply -f -

# 3. LiteLLM (Anthropic key + master key — only on LiteLLM pod)
kubectl create secret generic litellm-credentials \
  --namespace cip-app \
  --from-literal=ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  --from-literal=LITELLM_MASTER_KEY="$LITELLM_MASTER_KEY" \
  --from-literal=LANGFUSE_PUBLIC_KEY="$LANGFUSE_PUBLIC_KEY" \
  --from-literal=LANGFUSE_SECRET_KEY="$LANGFUSE_SECRET_KEY" \
  --from-literal=LANGFUSE_HOST="$LANGFUSE_HOST" \
  --dry-run=client -o yaml | kubectl apply -f -

# 4. OVH Object Store
kubectl create secret generic ovh-object-store \
  --namespace cip-app \
  --from-literal=access-key="$OVH_S3_ACCESS_KEY" \
  --from-literal=secret-key="$OVH_S3_SECRET_KEY" \
  --from-literal=endpoint="$AWS_ENDPOINT_URL" \
  --from-literal=region="$AWS_REGION" \
  --dry-run=client -o yaml | kubectl apply -f -

# 5. PostgreSQL (cip-infra namespace for the DB pod)
kubectl create secret generic postgres-credentials \
  --namespace cip-infra \
  --from-literal=postgres-password="$PG_ADMIN_PASSWORD" \
  --from-literal=password="$PG_USER_PASSWORD" \
  --dry-run=client -o yaml | kubectl apply -f -

# 6. PostgreSQL copy to cip-auth for Keycloak
kubectl get secret postgres-credentials -n cip-infra -o yaml \
  | sed 's/namespace: cip-infra/namespace: cip-auth/' \
  | kubectl apply -f -

# 7. Cloudflare (for cert-manager)
kubectl create secret generic cloudflare-api-token \
  --namespace cert-manager \
  --from-literal=api-token="$CLOUDFLARE_API_TOKEN" \
  --dry-run=client -o yaml | kubectl apply -f -

# 8. Bot credentials
kubectl create secret generic teams-bot-credentials \
  --namespace cip-app \
  --from-literal=app-id="$BOT_APP_ID" \
  --from-literal=app-password="$BOT_APP_PASSWORD" \
  --dry-run=client -o yaml | kubectl apply -f -

# 9. Twilio + Resend (Communications service)
kubectl create secret generic communications-credentials \
  --namespace cip-app \
  --from-literal=twilio-account-sid="$TWILIO_ACCOUNT_SID" \
  --from-literal=twilio-auth-token="$TWILIO_AUTH_TOKEN" \
  --from-literal=twilio-phone-number="$TWILIO_PHONE_NUMBER" \
  --from-literal=resend-api-key="$RESEND_API_KEY" \
  --dry-run=client -o yaml | kubectl apply -f -

# 10. Keycloak admin
kubectl create secret generic keycloak-admin-credentials \
  --namespace cip-auth \
  --from-literal=admin-password="$KEYCLOAK_ADMIN_PASSWORD" \
  --dry-run=client -o yaml | kubectl apply -f -

# Verify all secrets exist
kubectl get secrets -n cip-app
kubectl get secrets -n cip-infra
kubectl get secrets -n cip-auth
kubectl get secrets -n cert-manager
```

---

## Section 11 — LiteLLM Startup Verification

After deploying LiteLLM (Slice 04 + Slice 12 `make start`):

```bash
kubectl port-forward -n cip-app svc/litellm 4000:4000 &

# Health check
curl -s http://localhost:4000/health/liveliness | jq .status
# Expected: "healthy"

# Confirm model aliases are registered
curl -s http://localhost:4000/models \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  | jq '[.data[].id]'
# Expected: ["cip-vision","cip-chat","cip-lightweight","cip-reasoning"]

# Issue the dev tenant virtual key
curl -s -X POST http://localhost:4000/key/generate \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"key_alias\": \"dev-tenant\",
    \"models\": [\"cip-vision\",\"cip-chat\",\"cip-lightweight\",\"cip-reasoning\"],
    \"max_budget\": 20,
    \"budget_duration\": \"30d\",
    \"metadata\": {\"tenantId\": \"$DEV_TENANT_ID\"}
  }" | jq .key

# Copy the returned key and update .envrc:
# export LITELLM_VIRTUAL_KEY="sk-..."

# Make a real LLM call to confirm the full chain works
curl -s http://localhost:4000/chat/completions \
  -H "Authorization: Bearer $LITELLM_VIRTUAL_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"cip-lightweight","messages":[{"role":"user","content":"respond with only the word: ready"}]}' \
  | jq .choices[0].message.content
# Expected: "ready"

# Check Langfuse — the call should appear within 10 seconds
# Go to cloud.langfuse.com → your project → Traces
# Should see: model=claude-haiku, provider=anthropic, cost in USD
```

---

## Section 12 — Keycloak JWT Verification

After Keycloak is deployed and the Protocol Mappers are configured (see `CIP_Integration_Wiring_v0_2.docx` Section 6.2):

```bash
# Get a token for the dev admin user
TOKEN=$(curl -s -X POST \
  "https://keycloak.dev.cip.io/realms/cip-dev/protocol/openid-connect/token" \
  -d "client_id=platform-api&grant_type=password&username=devadmin&password=$KEYCLOAK_ADMIN_PASSWORD" \
  | jq -r .access_token)

# Decode and verify claims
echo $TOKEN | cut -d'.' -f2 | base64 -d 2>/dev/null | jq '{
  sub,
  tenantId,
  systemRole,
  preferred_username,
  exp
}'

# Expected output:
# {
#   "sub": "some-keycloak-uuid",
#   "tenantId": "00000000-0000-0000-0000-000000000001",
#   "systemRole": "platform_admin",
#   "preferred_username": "devadmin",
#   "exp": <unix timestamp>
# }
#
# If tenantId is missing: Protocol Mapper is not configured.
# See CIP_Integration_Wiring_v0_2.docx Section 6.2 for the Admin API call to add it.
```

---

## Section 13 — Final Pre-Code Verification

Run this full checklist before starting Slice 01:

```bash
#!/usr/bin/env bash
# scripts/verify-readiness.sh
# Run this after completing all sections of SLICE_00_INFRA.md
set -euo pipefail

echo "=== CIP Platform Readiness Check ==="
echo ""

echo "▶ kubectl connectivity..."
kubectl get nodes | grep -q "Ready" && echo "  ✅ Cluster reachable" || echo "  ❌ FAIL: kubectl not connected"

echo "▶ Namespaces..."
kubectl get ns cip-app &>/dev/null && echo "  ✅ cip-app exists" || echo "  ❌ FAIL: cip-app missing"
kubectl get ns cip-infra &>/dev/null && echo "  ✅ cip-infra exists" || echo "  ❌ FAIL: cip-infra missing"

echo "▶ K8s Secrets..."
kubectl get secret temporal-credentials -n cip-app &>/dev/null && echo "  ✅ temporal-credentials" || echo "  ❌ FAIL: temporal-credentials missing"
kubectl get secret langfuse-credentials -n cip-app &>/dev/null && echo "  ✅ langfuse-credentials" || echo "  ❌ FAIL: langfuse-credentials missing"
kubectl get secret litellm-credentials -n cip-app &>/dev/null && echo "  ✅ litellm-credentials" || echo "  ❌ FAIL: litellm-credentials missing"
kubectl get secret ovh-object-store -n cip-app &>/dev/null && echo "  ✅ ovh-object-store" || echo "  ❌ FAIL: ovh-object-store missing"
kubectl get secret cloudflare-api-token -n cert-manager &>/dev/null && echo "  ✅ cloudflare-api-token" || echo "  ❌ FAIL: cloudflare-api-token missing"

echo "▶ OVH Object Store..."
aws s3 ls --endpoint-url "$AWS_ENDPOINT_URL" &>/dev/null && echo "  ✅ S3 reachable" || echo "  ❌ FAIL: OVH S3 not reachable"

echo "▶ Temporal Cloud..."
temporal operator namespace list 2>/dev/null | grep -q "$TEMPORAL_NAMESPACE" && echo "  ✅ Temporal namespace exists" || echo "  ❌ FAIL: Temporal namespace not found"

echo "▶ Langfuse Cloud..."
STATUS=$(curl -s "https://cloud.langfuse.com/api/public/health" -u "$LANGFUSE_PUBLIC_KEY:$LANGFUSE_SECRET_KEY" | jq -r .status 2>/dev/null)
[ "$STATUS" = "OK" ] && echo "  ✅ Langfuse reachable" || echo "  ❌ FAIL: Langfuse health check failed"

echo "▶ Cloudflare API token..."
CF_STATUS=$(curl -s "https://api.cloudflare.com/client/v4/user/tokens/verify" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" | jq -r .result.status 2>/dev/null)
[ "$CF_STATUS" = "active" ] && echo "  ✅ Cloudflare token valid" || echo "  ❌ FAIL: Cloudflare token invalid"

echo "▶ .envrc completeness..."
REQUIRED_VARS=(
  OVH_PROJECT_ID OVH_APP_KEY OVH_APP_SECRET OVH_CONSUMER_KEY
  OVH_CLUSTER_ID OVH_NODEPOOL_ID
  OVH_S3_ACCESS_KEY OVH_S3_SECRET_KEY AWS_ENDPOINT_URL
  CF_ZONE_ID CF_ACCOUNT_ID CLOUDFLARE_API_TOKEN
  TEMPORAL_NAMESPACE TEMPORAL_ADDRESS TEMPORAL_API_KEY
  LANGFUSE_PUBLIC_KEY LANGFUSE_SECRET_KEY LANGFUSE_HOST
  ANTHROPIC_API_KEY
  PG_ADMIN_PASSWORD PG_USER_PASSWORD
  KEYCLOAK_ADMIN_PASSWORD KEYCLOAK_URL KEYCLOAK_REALM KEYCLOAK_CLIENT_ID
  LITELLM_MASTER_KEY LITELLM_BASE_URL
  TWILIO_ACCOUNT_SID TWILIO_AUTH_TOKEN TWILIO_PHONE_NUMBER
  RESEND_API_KEY
  BOT_APP_ID BOT_APP_PASSWORD
  DEV_TENANT_ID
)
MISSING=0
for var in "${REQUIRED_VARS[@]}"; do
  if [ -z "${!var:-}" ]; then
    echo "  ❌ MISSING: $var"
    MISSING=$((MISSING+1))
  fi
done
[ $MISSING -eq 0 ] && echo "  ✅ All required env vars set" || echo "  ❌ $MISSING variables missing from .envrc"

echo ""
echo "=== Readiness check complete ==="
echo "Fix any ❌ items before starting Slice 01."
```

---

## `.envrc` — Complete Template

Copy this into your `.envrc` and fill in every value before proceeding. This file is the single source of truth for all credentials. **Never commit it to source control.**

```bash
# .envrc — CIP Platform Dev Environment
# This file is NEVER committed. Add .envrc to .gitignore (already done).
# Backup: store encrypted in 1Password or similar. If this file and the K8s secrets
# are both lost, all credentials must be regenerated from each service's dashboard.

# ── OVH ──────────────────────────────────────────────────────────────────────
export OVH_PROJECT_ID=""
export OVH_APP_KEY=""
export OVH_APP_SECRET=""
export OVH_CONSUMER_KEY=""
export OVH_ENDPOINT="ovh-ca"
export OVH_CLUSTER_ID=""
export OVH_NODEPOOL_ID=""
export OVH_LB_IP=""           # fill in after Nginx Ingress is deployed
export KUBECONFIG="$HOME/.kube/cip-dev.yaml"

# ── OVH Object Store (S3-compatible) ─────────────────────────────────────────
export OVH_S3_ACCESS_KEY=""
export OVH_S3_SECRET_KEY=""
export AWS_ENDPOINT_URL="https://s3.bhs.io.cloud.ovh.net"
export AWS_REGION="BHS"
export AWS_ACCESS_KEY_ID="$OVH_S3_ACCESS_KEY"
export AWS_SECRET_ACCESS_KEY="$OVH_S3_SECRET_KEY"

# ── Cloudflare ────────────────────────────────────────────────────────────────
export CF_ZONE_ID=""
export CF_ACCOUNT_ID=""
export CLOUDFLARE_API_TOKEN=""

# ── Temporal Cloud ────────────────────────────────────────────────────────────
export TEMPORAL_NAMESPACE="cip-dev-00000000-0000-0000-0000-000000000001"
export TEMPORAL_ADDRESS=""    # format: <namespace>.<account>.tmprl.cloud:7233
export TEMPORAL_API_KEY=""
export TEMPORAL_TASK_QUEUE_HR="cip-hr-tasks"
export TEMPORAL_TASK_QUEUE_PLATFORM="cip-platform-tasks"

# ── Langfuse Cloud ────────────────────────────────────────────────────────────
export LANGFUSE_PUBLIC_KEY=""  # pk-lf-...
export LANGFUSE_SECRET_KEY=""  # sk-lf-...
export LANGFUSE_HOST="https://cloud.langfuse.com"

# ── Anthropic (LiteLLM pod only) ──────────────────────────────────────────────
# DO NOT inject this into domain service pods. LiteLLM pod only.
export ANTHROPIC_API_KEY=""    # sk-ant-...

# ── PostgreSQL ────────────────────────────────────────────────────────────────
export PG_ADMIN_PASSWORD=""
export PG_USER_PASSWORD=""
export DATABASE_URL_HR="postgresql://cipuser:${PG_USER_PASSWORD}@postgres-postgresql.cip-infra:5432/cip_hr"
export DATABASE_URL_PLATFORM="postgresql://cipuser:${PG_USER_PASSWORD}@postgres-postgresql.cip-infra:5432/cip_platform"
export DATABASE_URL_LITELLM="postgresql://cipuser:${PG_USER_PASSWORD}@postgres-postgresql.cip-infra:5432/cip_litellm"

# ── Keycloak ──────────────────────────────────────────────────────────────────
export KEYCLOAK_ADMIN_PASSWORD=""
export KEYCLOAK_URL="https://keycloak.dev.cip.io"
export KEYCLOAK_REALM="cip-dev"
export KEYCLOAK_CLIENT_ID="platform-api"

# ── LiteLLM ───────────────────────────────────────────────────────────────────
export LITELLM_MASTER_KEY=""   # sk-cip-master-... (generated)
export LITELLM_BASE_URL="http://litellm.cip-app.svc.cluster.local:4000"
export LITELLM_VIRTUAL_KEY=""  # sk-... (issued by LiteLLM after Section 11)

# ── Twilio (SMS) ──────────────────────────────────────────────────────────────
export TWILIO_ACCOUNT_SID=""   # AC...
export TWILIO_AUTH_TOKEN=""
export TWILIO_PHONE_NUMBER=""  # +1...

# ── Resend (Email) ────────────────────────────────────────────────────────────
export RESEND_API_KEY=""       # re_...
export RESEND_FROM_EMAIL="notifications@cip.io"

# ── Azure Bot Service (Teams) ─────────────────────────────────────────────────
export BOT_APP_ID=""           # GUID
export BOT_APP_PASSWORD=""     # client secret

# ── Dev tenant (fixed UUID for dev environment) ───────────────────────────────
export DEV_TENANT_ID="00000000-0000-0000-0000-000000000001"
```

---

## What Can Go Wrong — Troubleshooting Table

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| `kubectl` connects but pods crash immediately | K8s Secret missing or wrong key name | Run `kubectl describe pod <name> -n cip-app` → check `envFrom` errors |
| LiteLLM returns 401 | Wrong master key or virtual key | Re-check `litellm-credentials` secret; `kubectl exec` into pod and echo `$LITELLM_MASTER_KEY` |
| LiteLLM returns 402 / budget exceeded | Virtual key hit the `max_budget` | Call LiteLLM Admin API to increase budget or issue a new key |
| Langfuse traces not appearing | Langfuse SDK not initialised, wrong keys | Check pod logs for `langfuse` errors; verify secret is mounted |
| Temporal worker not polling | Wrong `TEMPORAL_ADDRESS` format, missing port | Address must end in `:7233`; must include full namespace + account string |
| Temporal worker: auth error | API key expired or wrong | Create a new API key in cloud.temporal.io; update `temporal-credentials` secret |
| JWT missing `tenantId` claim | Protocol Mapper not configured in Keycloak | Run the Admin API call in `CIP_Integration_Wiring_v0_2.docx` Section 6.2 |
| Cloudflare shows 522 (connection timeout) | OVH LB not running or wrong IP in DNS | Check `kubectl get svc -n ingress-nginx`; update DNS A record to new LB IP |
| Cloudflare shows 526 (invalid SSL) | cert-manager hasn't issued cert yet, or SSL mode wrong | Check `kubectl get certificate -A`; ensure Cloudflare SSL mode is Full (Strict) not Full |
| S3 upload fails | Wrong endpoint, wrong region, or bucket doesn't exist | `aws s3 ls --endpoint-url $AWS_ENDPOINT_URL` — if this fails, credentials are wrong |
| `create-secrets.sh` fails on namespace | Namespace not created yet | `kubectl apply -f infra/k8s/namespaces.yaml` first |
