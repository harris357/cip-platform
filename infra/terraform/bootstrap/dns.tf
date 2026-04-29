# DNS records for cip.idlevice.ca (Cloudflare zone: idlevice.ca).
#
# Admin services (keycloak.cip, grafana.cip, langfuse.cip) are managed automatically
# by cloudflared as Tunnel-type records — do not manage those here.
#
# Only the Teams bot A record is managed by Terraform (it bypasses the tunnel).
# Set TF_VAR_ingress_ip to the OVH floating IP before applying.

locals {
  tunnel_id = jsondecode(base64decode(var.cloudflare_tunnel_token))["t"]
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
  name    = "bot.cip"
  content = var.ingress_ip
  type    = "A"
  proxied = false
}
