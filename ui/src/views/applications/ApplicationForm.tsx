import { Application } from "@chirpstack/chirpstack-api-grpc-web/api/application_pb";
import { Form, Input, Select, Button, Tabs, Row, Col, Space } from "antd";
import type { TabsProps } from "antd/lib";
import { MinusCircleOutlined, PlusOutlined } from "@ant-design/icons";
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

import { onFinishFailed } from "../helpers";

// Map pin icon options. The `value` is the bare Font Awesome Free glyph name
// used both here (for the preview) and by Map.tsx's Marker component (which
// passes it straight through to leaflet.awesome-markers as `faIcon`).
const iconOptions: { value: string; icon: IconDefinition }[] = [
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
  initialValues: Application;
  onFinish: (obj: Application) => void;
  disabled?: boolean;
}

function ApplicationForm(props: IProps) {
  const onFinish = (values: Application.AsObject) => {
    const v = Object.assign(props.initialValues.toObject(), values);
    const app = new Application();

    app.setId(v.id);
    app.setTenantId(v.tenantId);
    app.setName(v.name);
    app.setDescription(v.description);
    app.setIcon(v.icon || "");

    // tags
    for (const elm of v.tagsMap) {
      app.getTagsMap().set(elm[0], elm[1]);
    }

    props.onFinish(app);
  };

  const tabItems: TabsProps["items"] = [
    {
      key: "1",
      label: "General",
      children: (
        <>
          <Form.Item label="Name" name="name" rules={[{ required: true, message: "Please enter a name!" }]}>
            <Input disabled={props.disabled} />
          </Form.Item>
          <Form.Item label="Description" name="description">
            <Input.TextArea disabled={props.disabled} />
          </Form.Item>
          <Form.Item
            label="Map pin icon"
            name="icon"
            tooltip="Used to render this application's devices and gateways on a map."
          >
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
        </>
      ),
    },
    {
      key: "2",
      label: "Tags",
      children: (
        <Form.List name="tagsMap">
          {(fields, { add, remove }) => (
            <>
              {fields.map(({ key, name, ...restField }) => (
                <Row gutter={24} key={key}>
                  <Col xs={24} sm={6}>
                    <Form.Item
                      {...restField}
                      name={[name, 0]}
                      rules={[{ required: true, message: "Please enter a key!" }]}
                    >
                      <Input placeholder="Key" />
                    </Form.Item>
                  </Col>
                  <Col xs={20} sm={16}>
                    <Form.Item
                      {...restField}
                      name={[name, 1]}
                      rules={[{ required: true, message: "Please enter a value!" }]}
                    >
                      <Input placeholder="Value" />
                    </Form.Item>
                  </Col>
                  <Col xs={4} sm={2}>
                    <MinusCircleOutlined onClick={() => remove(name)} />
                  </Col>
                </Row>
              ))}
              <Form.Item>
                <Button type="dashed" onClick={() => add()} block icon={<PlusOutlined />}>
                  Add tag
                </Button>
              </Form.Item>
            </>
          )}
        </Form.List>
      ),
    },
  ];

  return (
    <Form
      layout="vertical"
      initialValues={props.initialValues.toObject()}
      onFinish={onFinish}
      onFinishFailed={onFinishFailed}
    >
      <Tabs items={tabItems} />
      <Form.Item>
        <Button type="primary" htmlType="submit" disabled={props.disabled}>
          Submit
        </Button>
      </Form.Item>
    </Form>
  );
}

export default ApplicationForm;
