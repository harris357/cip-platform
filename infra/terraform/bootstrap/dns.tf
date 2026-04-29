# DNS records for cip.idlevice.ca (Cloudflare zone: idlevice.ca).
#
# Tunnel-backed admin services (keycloak, grafana, langfuse, litellm) are managed
# here as proxied CNAMEs pointing to the tunnel. This is equivalent to registering
# them as Public Hostnames in the Zero Trust dashboard.
#
# The Teams bot A record bypasses the tunnel and hits OVH LB / nginx directly.
# Set TF_VAR_ingress_ip to the OVH floating IP before applying.

locals {
  tunnel_id    = jsondecode(base64decode(var.cloudflare_tunnel_token))["t"]
  tunnel_cname = "${local.tunnel_id}.cfargotunnel.com"
  bot_host     = "bot-${var.env_prefix}"
}

data "cloudflare_zone" "main" {
  name = var.cloudflare_zone
}

# Teams bot — bypasses the tunnel, hits OVH LB / nginx directly
variable "ingress_ip" {
  type        = string
  description = "OVH floating IP for the ingress-nginx LoadBalancer. Run 'make get-lb-ip' after cluster setup."
  default     = ""
}

resource "cloudflare_record" "bot" {
  count   = var.ingress_ip != "" ? 1 : 0
  zone_id = data.cloudflare_zone.main.id
  name    = local.bot_host
  content = var.ingress_ip
  type    = "A"
  proxied = false
}

# Tunnel-backed admin services — proxied CNAME → tunnel
resource "cloudflare_record" "keycloak" {
  zone_id = data.cloudflare_zone.main.id
  name    = "keycloak-${var.env_prefix}"
  content = local.tunnel_cname
  type    = "CNAME"
  proxied = true
}

resource "cloudflare_record" "grafana" {
  zone_id = data.cloudflare_zone.main.id
  name    = "grafana-${var.env_prefix}"
  content = local.tunnel_cname
  type    = "CNAME"
  proxied = true
}

resource "cloudflare_record" "langfuse" {
  zone_id = data.cloudflare_zone.main.id
  name    = "langfuse-${var.env_prefix}"
  content = local.tunnel_cname
  type    = "CNAME"
  proxied = true
}

resource "cloudflare_record" "litellm" {
  zone_id = data.cloudflare_zone.main.id
  name    = "litellm-${var.env_prefix}"
  content = local.tunnel_cname
  type    = "CNAME"
  proxied = true
}
