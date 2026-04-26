resource "ovh_cloud_project_container" "cip_certs" {
  service_name = var.ovh_cloud_project_service
  region_name  = var.region
  name         = "cip-certs"
}
