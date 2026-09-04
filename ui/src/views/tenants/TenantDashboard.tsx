import type { ReactElement } from "react";
import { useEffect, useState } from "react";
import { Link } from "react-router";

import { presetPalettes } from "@ant-design/colors";
import { Card, Col, Row, Space, Empty, Radio } from "antd";
import type { RadioChangeEvent } from "antd";

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
import type { MarkerColor, HeatmapPoint } from "../../components/Map";
import Map, { Marker, Heatmap } from "../../components/Map";

// Fallback map pin icon for devices whose application has no icon set.
const defaultDeviceIcon = "map-marker";

// Fallback map pin icon for gateways with no icon set.
const defaultGatewayIcon = "wifi";

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

// Marker pin color for a device's activity status, independent of
// deviceActivityStatus's text color (which uses orange for "Never seen" to
// match the rest of the UI's active/inactive/never palette) -- on the map,
// gray reads more clearly as "no data yet" than orange does against markers
// that are already red/green.
function deviceMarkerColor(label: string): MarkerColor {
  switch (label) {
    case "Active":
      return "green";
    case "Inactive":
      return "red";
    default:
      return "lightgray";
  }
}

// A Google Drive "share" link (https://drive.google.com/file/d/<id>/view or
// .../open?id=<id>) serves an HTML viewer page, not raw image bytes, so it
// can't be used directly as an <img> src. Rewrite it to Drive's public
// thumbnail endpoint, which works for anyone with the file's link. Any
// other host is assumed to already be a direct image URL.
function toThumbnailUrl(url: string): string {
  if (!url.includes("drive.google.com")) {
    return url;
  }

  const match = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/) || url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (match === null) {
    return url;
  }

  return `https://drive.google.com/thumbnail?id=${match[1]}&sz=w200`;
}

// Typical LoRa receive-sensitivity range for the sub-GHz ISM bands: weak
// (near the noise floor) to strong (close range / clear line of sight).
const rssiWeak = -130;
const rssiStrong = -60;

function normalizeRssi(rssi: number): number {
  const clamped = Math.min(rssiStrong, Math.max(rssiWeak, rssi));
  return (clamped - rssiWeak) / (rssiStrong - rssiWeak);
}

type MapMode = "markers" | "coverage";

interface NetworkMapProps {
  tenantId: string;
  mode: MapMode;
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
  const heatPoints: HeatmapPoint[] = [];

  for (const item of props.gateways) {
    if (props.mode !== "markers") {
      continue;
    }

    const loc = item.getLocation();
    // Gateways always carry a Location in the API response (default 0, 0
    // when never set), so an unset location can't be detected via
    // getLocation() === undefined -- only via the coordinates themselves.
    if (loc === undefined || (loc.getLatitude() === 0 && loc.getLongitude() === 0)) {
      continue;
    }

    const pos: LatLngTuple = [loc.getLatitude(), loc.getLongitude()];
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
      <Marker
        position={[pos[0], pos[1]]}
        faIcon={item.getIcon() || defaultGatewayIcon}
        color={color}
        key={`gw-${item.getGatewayId()}`}
      >
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

    const lastSeenGatewayId = item.getLastSeenGatewayId();

    if (props.mode === "coverage") {
      if (lastSeenGatewayId !== "") {
        heatPoints.push({
          lat: pos[0],
          lng: pos[1],
          intensity: normalizeRssi(item.getLastSeenGatewayRssi()),
        });
      }
      continue;
    }

    const icon = props.applicationIcons.get(item.getApplicationId()) || defaultDeviceIcon;
    const lastSeenAt = item.getLastSeenAt() !== undefined ? item.getLastSeenAt()!.toDate() : undefined;
    const status = deviceActivityStatus(lastSeenAt, item.getUplinkInterval());

    markers.push(
      <Marker
        position={[pos[0], pos[1]]}
        faIcon={icon}
        color={deviceMarkerColor(status.label)}
        key={`dev-${item.getDevEui()}`}
      >
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
          {item.getPhotoUrlsList().length > 0 && (
            <>
              <br />
              <Space size={4} style={{ marginTop: 4 }}>
                {item.getPhotoUrlsList().map(url => (
                  <a href={url} target="_blank" rel="noreferrer" key={url}>
                    <img
                      src={toThumbnailUrl(url)}
                      alt="Meter"
                      style={{ width: 50, height: 50, objectFit: "cover", borderRadius: 4 }}
                    />
                  </a>
                ))}
              </Space>
            </>
          )}
        </Popup>
      </Marker>,
    );
  }

  if (props.mode === "coverage" && heatPoints.length === 0) {
    return <Empty description="No signal readings yet" />;
  }

  if (props.mode === "markers" && bounds.length === 0) {
    return <Empty description="No gateways or devices with a known location" />;
  }

  return (
    <Map height={500} bounds={bounds} boundsOptions={boundsOptions}>
      {props.mode === "coverage" ? <Heatmap points={heatPoints} /> : markers}
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
  const [mapMode, setMapMode] = useState<MapMode>("markers");

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
      <Card
        title="Map"
        extra={
          <Radio.Group
            value={mapMode}
            onChange={(e: RadioChangeEvent) => setMapMode(e.target.value as MapMode)}
            size="small"
          >
            <Radio.Button value="markers">Markers</Radio.Button>
            <Radio.Button value="coverage">Coverage</Radio.Button>
          </Radio.Group>
        }
      >
        <NetworkMap
          tenantId={tenant.getId()}
          mode={mapMode}
          gateways={gatewayItems}
          devices={deviceItems}
          applicationIcons={applicationIcons}
        />
      </Card>
    </Space>
  );
}

export default TenantDashboard;
