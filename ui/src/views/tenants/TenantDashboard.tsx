import type { ReactElement } from "react";
import { useEffect, useState } from "react";
import { Link } from "react-router";

import { presetPalettes } from "@ant-design/colors";
import { Card, Col, Row, Space, Empty } from "antd";

import { formatDistanceToNow } from "date-fns";
import type { LatLngTuple, PointTuple } from "leaflet";
import { Popup } from "react-leaflet";
import { Doughnut } from "react-chartjs-2";

import type { Tenant } from "@chirpstack/chirpstack-api-grpc-web/api/tenant_pb";

import type {
  GetGatewaysSummaryResponse,
  GetDevicesSummaryResponse,
} from "@chirpstack/chirpstack-api-grpc-web/api/internal_pb";
import {
  GetGatewaysSummaryRequest,
  GetDevicesSummaryRequest,
} from "@chirpstack/chirpstack-api-grpc-web/api/internal_pb";

import type { ListGatewaysResponse, GatewayListItem } from "@chirpstack/chirpstack-api-grpc-web/api/gateway_pb";
import { ListGatewaysRequest, GatewayState } from "@chirpstack/chirpstack-api-grpc-web/api/gateway_pb";
import type { ListDevicesResponse, DeviceListItem } from "@chirpstack/chirpstack-api-grpc-web/api/device_pb";
import { ListDevicesRequest } from "@chirpstack/chirpstack-api-grpc-web/api/device_pb";
import type { ListApplicationsResponse } from "@chirpstack/chirpstack-api-grpc-web/api/application_pb";
import { ListApplicationsRequest } from "@chirpstack/chirpstack-api-grpc-web/api/application_pb";

import InternalStore from "../../stores/InternalStore";
import GatewayStore from "../../stores/GatewayStore";
import DeviceStore from "../../stores/DeviceStore";
import ApplicationStore from "../../stores/ApplicationStore";
import type { MarkerColor } from "../../components/Map";
import Map, { Marker } from "../../components/Map";

// Fallback map pin icon for devices whose application has no icon set.
const defaultDeviceIcon = "map-marker";

// Mirrors the never-seen / inactive / active rule used by
// storage::device::get_active_inactive on the backend (which only computes
// this as an aggregate, not per-device): a device is considered inactive
// once it has gone quiet for more than 1.5x its device-profile's uplink
// interval.
function deviceActivityStatus(
  lastSeenAt: Date | undefined,
  uplinkInterval: number,
): { label: string; color: string } {
  if (lastSeenAt === undefined) {
    return { label: "Never seen", color: presetPalettes.orange.primary! };
  }

  if (uplinkInterval > 0 && Date.now() - lastSeenAt.getTime() > uplinkInterval * 1000 * 1.5) {
    return { label: "Inactive", color: presetPalettes.red.primary! };
  }

  return { label: "Active", color: presetPalettes.green.primary! };
}

interface NetworkMapProps {
  tenantId: string;
  gateways: GatewayListItem[];
  devices: DeviceListItem[];
  applicationIcons: globalThis.Map<string, string>;
}

function NetworkMap(props: NetworkMapProps) {
  if (props.gateways.length === 0 && props.devices.length === 0) {
    return <Empty />;
  }

  const boundsOptions: {
    padding: PointTuple;
  } = {
    padding: [50, 50],
  };

  const bounds: LatLngTuple[] = [];
  const markers: ReactElement[] = [];

  for (const item of props.gateways) {
    if (item.getLocation() === undefined) {
      continue;
    }

    const pos: LatLngTuple = [item.getLocation()!.getLatitude(), item.getLocation()!.getLongitude()];
    bounds.push(pos);

    let color: MarkerColor = "orange";
    let lastSeen: string = "Never seen online";

    if (item.getState() === GatewayState.OFFLINE) {
      color = "red";
    } else if (item.getState() === GatewayState.ONLINE) {
      color = "green";
    }

    if (item.getLastSeenAt() !== undefined) {
      lastSeen = formatDistanceToNow(item.getLastSeenAt()!.toDate(), { addSuffix: true });
    }

    markers.push(
      <Marker position={[pos[0], pos[1]]} faIcon="wifi" color={color} key={`gw-${item.getGatewayId()}`}>
        <Popup>
          <Link to={`/tenants/${item.getTenantId()}/gateways/${item.getGatewayId()}`}>{item.getName()}</Link>
          <br />
          {item.getGatewayId()}
          <br />
          <br />
          {lastSeen}
        </Popup>
      </Marker>,
    );
  }

  const gatewayNames = new globalThis.Map<string, string>();
  for (const gw of props.gateways) {
    gatewayNames.set(gw.getGatewayId(), gw.getName());
  }

  for (const item of props.devices) {
    if (!item.hasLatitude() || !item.hasLongitude()) {
      continue;
    }

    const pos: LatLngTuple = [item.getLatitude(), item.getLongitude()];
    bounds.push(pos);

    const icon = props.applicationIcons.get(item.getApplicationId()) || defaultDeviceIcon;
    const lastSeenAt = item.getLastSeenAt() !== undefined ? item.getLastSeenAt()!.toDate() : undefined;
    const status = deviceActivityStatus(lastSeenAt, item.getUplinkInterval());
    const lastSeenGatewayId = item.getLastSeenGatewayId();

    markers.push(
      <Marker position={[pos[0], pos[1]]} faIcon={icon} color="blue" key={`dev-${item.getDevEui()}`}>
        <Popup>
          <Link
            to={`/tenants/${props.tenantId}/applications/${item.getApplicationId()}/devices/${item.getDevEui()}`}
          >
            {item.getName()}
          </Link>
          <br />
          {item.getDevEui()}
          <br />
          {item.getDeviceProfileName()}
          <br />
          <span style={{ color: status.color }}>{status.label}</span>
          <br />
          <br />
          {lastSeenGatewayId !== "" ? (
            <>
              Last detected by {gatewayNames.get(lastSeenGatewayId) || lastSeenGatewayId}
              <br />
              RSSI: {item.getLastSeenGatewayRssi()} dBm
              <br />
            </>
          ) : (
            <>
              No uplinks received yet
              <br />
            </>
          )}
          {lastSeenAt !== undefined && formatDistanceToNow(lastSeenAt, { addSuffix: true })}
        </Popup>
      </Marker>,
    );
  }

  return (
    <Map height={500} bounds={bounds} boundsOptions={boundsOptions}>
      {markers}
    </Map>
  );
}

interface GatewayProps {
  summary?: GetGatewaysSummaryResponse;
}

function GatewaysActiveInactive(props: GatewayProps) {
  if (
    props.summary === undefined ||
    (props.summary.getNeverSeenCount() === 0 &&
      props.summary.getOfflineCount() === 0 &&
      props.summary.getOnlineCount() === 0)
  ) {
    return <Empty />;
  }

  const data = {
    labels: ["Never seen", "Offline", "Online"],
    datasets: [
      {
        data: [props.summary.getNeverSeenCount(), props.summary.getOfflineCount(), props.summary.getOnlineCount()],
        backgroundColor: [presetPalettes.orange.primary, presetPalettes.red.primary, presetPalettes.green.primary],
      },
    ],
  };

  const options: {
    animation: boolean;
    responsive: boolean;
    maintainAspectRatio: boolean;
  } = {
    animation: false,
    responsive: true,
    maintainAspectRatio: false,
  };

  return (
    <div className="chart-doughnut">
      <Doughnut data={data} options={options} />
    </div>
  );
}

interface DeviceProps {
  summary?: GetDevicesSummaryResponse;
}

function DevicesActiveInactive(props: DeviceProps) {
  if (
    props.summary === undefined ||
    (props.summary.getNeverSeenCount() === 0 &&
      props.summary.getInactiveCount() === 0 &&
      props.summary.getActiveCount() === 0)
  ) {
    return <Empty />;
  }

  const data = {
    labels: ["Never seen", "Inactive", "Active"],
    datasets: [
      {
        data: [props.summary.getNeverSeenCount(), props.summary.getInactiveCount(), props.summary.getActiveCount()],
        backgroundColor: [presetPalettes.orange.primary, presetPalettes.red.primary, presetPalettes.green.primary],
      },
    ],
  };

  const options: {
    animation: boolean;
    responsive: boolean;
    maintainAspectRatio: boolean;
  } = {
    animation: false,
    responsive: true,
    maintainAspectRatio: false,
  };

  return (
    <div className="chart-doughnut">
      <Doughnut data={data} options={options} />
    </div>
  );
}

function DevicesDataRates(props: DeviceProps) {
  const getColor = (dr: number) => {
    return [
      "#ff5722",
      "#ff9800",
      "#ffc107",
      "#ffeb3b",
      "#cddc39",
      "#8bc34a",
      "#4caf50",
      "#009688",
      "#00bcd4",
      "#03a9f4",
      "#2196f3",
      "#3f51b5",
      "#673ab7",
      "#9c27b0",
      "#e91e63",
    ][dr];
  };

  if (props.summary === undefined || props.summary.getDrCountMap().toArray().length === 0) {
    return <Empty />;
  }

  const data: {
    labels: string[];
    datasets: {
      data: number[];
      backgroundColor: string[];
    }[];
  } = {
    labels: [],
    datasets: [
      {
        data: [],
        backgroundColor: [],
      },
    ],
  };

  for (const elm of props.summary.getDrCountMap().toArray()) {
    data.labels.push(`DR${elm[0]}`);
    data.datasets[0].data.push(elm[1]);
    data.datasets[0].backgroundColor.push(getColor(elm[0]));
  }

  const options: {
    animation: boolean;
    responsive: boolean;
    maintainAspectRatio: boolean;
  } = {
    animation: false,
    responsive: true,
    maintainAspectRatio: false,
  };

  return (
    <div className="chart-doughnut">
      <Doughnut data={data} options={options} />
    </div>
  );
}

function TenantDashboard({ tenant }: { tenant: Tenant }) {
  const [gatewayItems, setGatewayItems] = useState<GatewayListItem[]>([]);
  const [deviceItems, setDeviceItems] = useState<DeviceListItem[]>([]);
  const [applicationIcons, setApplicationIcons] = useState<globalThis.Map<string, string>>(new globalThis.Map());
  const [gatewaysSummary, setGatewaysSummary] = useState<GetGatewaysSummaryResponse | undefined>(undefined);
  const [devicesSummary, setDevicesSummary] = useState<GetDevicesSummaryResponse | undefined>(undefined);

  useEffect(() => {
    {
      const req = new GetGatewaysSummaryRequest();
      req.setTenantId(tenant.getId());

      InternalStore.getGatewaysSummary(req, (resp: GetGatewaysSummaryResponse) => {
        setGatewaysSummary(resp);
      });
    }

    {
      const req = new GetDevicesSummaryRequest();
      req.setTenantId(tenant.getId());

      InternalStore.getDevicesSummary(req, (resp: GetDevicesSummaryResponse) => {
        setDevicesSummary(resp);
      });
    }

    {
      const req = new ListGatewaysRequest();
      req.setTenantId(tenant.getId());
      req.setLimit(9999);

      GatewayStore.list(req, (resp: ListGatewaysResponse) => {
        setGatewayItems(resp.getResultList());
      });
    }

    {
      const req = new ListDevicesRequest();
      req.setTenantId(tenant.getId());
      req.setLimit(9999);

      DeviceStore.list(req, (resp: ListDevicesResponse) => {
        setDeviceItems(resp.getResultList());
      });
    }

    {
      const req = new ListApplicationsRequest();
      req.setTenantId(tenant.getId());
      req.setLimit(9999);

      ApplicationStore.list(req, (resp: ListApplicationsResponse) => {
        const icons = new globalThis.Map<string, string>();
        for (const item of resp.getResultList()) {
          if (item.getIcon() !== "") {
            icons.set(item.getId(), item.getIcon());
          }
        }
        setApplicationIcons(icons);
      });
    }
  }, [tenant]);

  return (
    <Space orientation="vertical" style={{ width: "100%" }} size="large">
      <Row gutter={24}>
        <Col xs={24} sm={12} md={8}>
          <Card title="Active devices">
            <DevicesActiveInactive summary={devicesSummary} />
          </Card>
        </Col>
        <Col xs={24} sm={12} md={8}>
          <Card title="Active gateways">
            <GatewaysActiveInactive summary={gatewaysSummary} />
          </Card>
        </Col>
        <Col xs={24} sm={12} md={8}>
          <Card title="Device data-rate usage">
            <DevicesDataRates summary={devicesSummary} />
          </Card>
        </Col>
      </Row>
      <Card title="Map">
        <NetworkMap
          tenantId={tenant.getId()}
          gateways={gatewayItems}
          devices={deviceItems}
          applicationIcons={applicationIcons}
        />
      </Card>
    </Space>
  );
}

export default TenantDashboard;
