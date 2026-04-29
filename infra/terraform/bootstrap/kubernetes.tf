resource "ovh_cloud_project_kube" "cip" {
  service_name = var.ovh_cloud_project_service
  name         = var.cluster_name
  region       = var.region
  version      = "1.35"

  # Private network — get IDs from OVH Console → Public Cloud → Network → Private Networks
  # Network ID = the OpenStack UUID shown on the network row (not the vRack ID)
  # Subnet ID  = click into the network → Subnets tab → copy the subnet UUID
  private_network_id = var.private_network_id

  private_network_configuration {
    # "" = no static gateway override (use DHCP)
    default_vrack_gateway              = ""
    # false = "Nodes public interface" outbound routing (nodes use their public IP for egress)
    # true  = "Nodes private interface" (requires a gateway in the private network)
    private_network_routing_as_default = false
  }

  lifecycle {
    # OVH API returns loadBalancersSubnetId from cluster state; sending it back as ""
    # causes a 400. The cluster is already provisioned — ignore all post-create changes.
    ignore_changes = all
  }
}
