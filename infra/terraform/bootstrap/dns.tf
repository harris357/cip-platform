# DNS zone records for cip.idlevice.ca (Cloudflare zone: cip.idlevice.ca).
# Configure after ingress IP is known — run `terraform apply -target=helm_release.ingress`
# in cluster/ first, then set TF_VAR_ingress_ip and apply this file.
#
# variable "ingress_ip" { type = string }
#
# resource "ovh_domain_zone_record" "keycloak" {
#   zone      = "cip.idlevice.ca"
#   subdomain = "keycloak"
#   fieldtype = "A"
#   ttl       = 300
#   target    = var.ingress_ip
# }
#
# resource "ovh_domain_zone_record" "api" {
#   zone      = "cip.idlevice.ca"
#   subdomain = "api"
#   fieldtype = "A"
#   ttl       = 300
#   target    = var.ingress_ip
# }
#
# resource "ovh_domain_zone_record" "langfuse" {
#   zone      = "cip.idlevice.ca"
#   subdomain = "langfuse"
#   fieldtype = "A"
#   ttl       = 300
#   target    = var.ingress_ip
# }
#
# resource "ovh_domain_zone_record" "bot" {
#   zone      = "cip.idlevice.ca"
#   subdomain = "bot"
#   fieldtype = "A"
#   ttl       = 300
#   target    = var.ingress_ip
# }
