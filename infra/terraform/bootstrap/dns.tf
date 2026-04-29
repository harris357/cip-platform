# DNS records for cip.idlevice.ca (Cloudflare zone).
#
# Admin services (keycloak, grafana, langfuse) CNAME to the Cloudflare Tunnel —
# no public ingress needed. Teams bot stays as an A record → OVH floating IP.
#
# Tunnel ID is derived at plan time from var.cloudflare_tunnel_token (no hardcoding).
# Set in .envrc:
#   export TF_VAR_cloudflare_api_token=$CLOUDFLARE_API_TOKEN
#   export TF_VAR_cloudflare_tunnel_token=$CLOUDFLARE_TUNNEL_TOKEN

locals {
  tunnel_id = jsondecode(base64decode(var.cloudflare_tunnel_token))["t"]
}

data "cloudflare_zone" "main" {
  name = var.cloudflare_zone
}

# Admin services — routed through Cloudflare Tunnel (Cloudflare Access enforces auth)
resource "cloudflare_record" "keycloak" {
  zone_id = data.cloudflare_zone.main.id
  name    = "keycloak"
  value   = "${local.tunnel_id}.cfargotunnel.com"
  type    = "CNAME"
  proxied = true
}

resource "cloudflare_record" "grafana" {
  zone_id = data.cloudflare_zone.main.id
  name    = "grafana"
  value   = "${local.tunnel_id}.cfargotunnel.com"
  type    = "CNAME"
  proxied = true
}

resource "cloudflare_record" "langfuse" {
  zone_id = data.cloudflare_zone.main.id
  name    = "langfuse"
  value   = "${local.tunnel_id}.cfargotunnel.com"
  type    = "CNAME"
  proxied = true
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
  name    = "bot"
  value   = var.ingress_ip
  type    = "A"
  proxied = false
}
