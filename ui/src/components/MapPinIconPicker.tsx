import { Form, Select, Space } from "antd";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faIndustry,
  faWarehouse,
  faBuilding,
  faHome,
  faHospital,
  faUniversity,
  faTractor,
  faLeaf,
  faTree,
  faWater,
  faTint,
  faBolt,
  faSun,
  faCloud,
  faSnowflake,
  faFire,
  faTruck,
  faShip,
  faPlane,
  faAnchor,
  faRoad,
  faShoppingCart,
  faGlobe,
  faCube,
  faMapMarker,
  faWifi,
} from "@fortawesome/free-solid-svg-icons";
import type { IconDefinition } from "@fortawesome/free-solid-svg-icons";

// Map pin icon options. The `value` is the bare Font Awesome Free glyph name
// used both here (for the preview) and by Map.tsx's Marker component (which
// passes it straight through to leaflet.awesome-markers as `faIcon`).
export const iconOptions: { value: string; icon: IconDefinition }[] = [
  { value: "map-marker", icon: faMapMarker },
  { value: "industry", icon: faIndustry },
  { value: "warehouse", icon: faWarehouse },
  { value: "building", icon: faBuilding },
  { value: "home", icon: faHome },
  { value: "hospital", icon: faHospital },
  { value: "university", icon: faUniversity },
  { value: "tractor", icon: faTractor },
  { value: "leaf", icon: faLeaf },
  { value: "tree", icon: faTree },
  { value: "water", icon: faWater },
  { value: "tint", icon: faTint },
  { value: "bolt", icon: faBolt },
  { value: "sun", icon: faSun },
  { value: "cloud", icon: faCloud },
  { value: "snowflake", icon: faSnowflake },
  { value: "fire", icon: faFire },
  { value: "truck", icon: faTruck },
  { value: "ship", icon: faShip },
  { value: "plane", icon: faPlane },
  { value: "anchor", icon: faAnchor },
  { value: "road", icon: faRoad },
  { value: "shopping-cart", icon: faShoppingCart },
  { value: "globe", icon: faGlobe },
  { value: "cube", icon: faCube },
  { value: "wifi", icon: faWifi },
];

interface IProps {
  tooltip: string;
  disabled?: boolean;
}

function MapPinIconPicker(props: IProps) {
  return (
    <Form.Item label="Map pin icon" name="icon" tooltip={props.tooltip}>
      <Select
        allowClear
        placeholder="Default"
        disabled={props.disabled}
        options={iconOptions.map(o => ({
          value: o.value,
          label: (
            <Space>
              <FontAwesomeIcon icon={o.icon} />
              {o.value}
            </Space>
          ),
        }))}
      />
    </Form.Item>
  );
}

export default MapPinIconPicker;
