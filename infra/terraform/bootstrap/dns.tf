# DNS zone records for cip.io subdomains.
# Configure after ingress IP is known — run `terraform apply -target=helm_release.ingress`
# in cluster/ first, then set TF_VAR_ingress_ip and apply this file.
#
# variable "ingress_ip" { type = string }
#
# resource "ovh_domain_zone_record" "keycloak" {
#   zone      = "cip.io"
#   subdomain = "keycloak.dev"
#   fieldtype = "A"
#   ttl       = 300
#   target    = var.ingress_ip
# }
#
# resource "ovh_domain_zone_record" "api" {
#   zone      = "cip.io"
#   subdomain = "api.dev"
#   fieldtype = "A"
#   ttl       = 300
#   target    = var.ingress_ip
# }
