import type { PropsWithChildren } from "react";
import { useEffect, useState } from "react";

import type { LatLngTuple, FitBoundsOptions } from "leaflet";
import L from "leaflet";
import "leaflet.awesome-markers";
import "leaflet.heat";
import type { MarkerProps as LMarkerProps } from "react-leaflet";
import { useMap } from "react-leaflet";
import { MapContainer, Marker as LMarker, TileLayer } from "react-leaflet";

import InternalStore from "../stores/InternalStore";

interface IProps {
  height: number;
  center?: [number, number];
  bounds?: LatLngTuple[];
  boundsOptions?: FitBoundsOptions;
}

function MapControl(props: { center?: [number, number]; bounds?: LatLngTuple[]; boundsOptions?: FitBoundsOptions }) {
  const map = useMap();

  useEffect(() => {
    if (map === undefined) {
      return;
    }

    if (props.center !== undefined) {
      map.flyTo(props.center);
    }

    if (props.bounds !== undefined) {
      map.flyToBounds(props.bounds, props.boundsOptions);
    }
  });

  return null;
}

function Map(props: PropsWithChildren<IProps>) {
  const [tileserver, setTileserver] = useState<string>("");
  const [attribution, setAttribution] = useState<string>("");

  useEffect(() => {
    const updateMapProperties = () => {
      InternalStore.settings(v => {
        setTileserver(v.getTileserverUrl());
        setAttribution(v.getMapAttribution());
      });
    };

    InternalStore.on("change", updateMapProperties);
    updateMapProperties();

    return () => {
      InternalStore.removeListener("change", updateMapProperties);
    };
  }, [props]);

  const style = {
    height: props.height,
  };

  if (attribution === "" || tileserver === "") {
    return null;
  }

  // Leaflet can't compute a bounding box from zero points (flyToBounds / fitBounds throw
  // trying to read the corner of an unset LatLngBounds), so an empty array must be treated
  // the same as "no bounds" rather than passed through.
  const bounds = props.bounds !== undefined && props.bounds.length > 0 ? props.bounds : undefined;

  return (
    <MapContainer
      bounds={bounds}
      boundsOptions={props.boundsOptions}
      center={props.center}
      zoom={13}
      scrollWheelZoom={false}
      style={style}
    >
      <TileLayer attribution={attribution} url={tileserver} />
      {props.children}
      <MapControl bounds={bounds} boundsOptions={props.boundsOptions} center={props.center} />
    </MapContainer>
  );
}

// "lightgray" isn't in the @types/leaflet.awesome-markers markerColor union,
// but the library's own CSS does define an awesome-marker-icon-lightgray
// class (along with several other colors the stale shipped types are
// missing) -- the assertion below is bridging an outdated .d.ts, not a real
// runtime gap.
export type MarkerColor =
  | "red"
  | "darkred"
  | "orange"
  | "green"
  | "darkgreen"
  | "blue"
  | "purple"
  | "darkpurple"
  | "cadetblue"
  | "lightgray"
  | undefined;

interface MarkerProps extends LMarkerProps {
  position: [number, number];
  faIcon: string;
  color: MarkerColor;
}

export function Marker(props: MarkerProps) {
  const { faIcon, color, position, ...otherProps } = props;

  const iconMarker = L.AwesomeMarkers.icon({
    icon: faIcon,
    prefix: "fa",
    markerColor: color as L.AwesomeMarkers.AwesomeMarkersIconOptions["markerColor"],
  });

  return (
    <LMarker icon={iconMarker} position={position} {...otherProps}>
      {props.children}
    </LMarker>
  );
}

export interface HeatmapPoint {
  lat: number;
  lng: number;
  // Normalized signal strength, 0 (weak) - 1 (strong).
  intensity: number;
}

// Red (weak) -> yellow -> green (strong), matching the color convention
// already used elsewhere in the UI (e.g. active/inactive status).
const heatmapGradient: L.ColorGradientConfig = {
  0.0: "#f5222d",
  0.5: "#faad14",
  1.0: "#52c41a",
};

interface HeatmapProps {
  points: HeatmapPoint[];
}

export function Heatmap(props: HeatmapProps) {
  const map = useMap();

  useEffect(() => {
    if (map === undefined) {
      return;
    }

    const layer = L.heatLayer(
      props.points.map(p => [p.lat, p.lng, p.intensity]),
      { gradient: heatmapGradient, radius: 25, blur: 20, maxZoom: 17 },
    );
    layer.addTo(map);

    return () => {
      layer.remove();
    };
  }, [map, props.points]);

  return null;
}

export default Map;
