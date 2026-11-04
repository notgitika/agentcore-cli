import { ChoiceField, type Choice } from "../../components/wizard";

export type ContainerBuild = "Container" | "Container-local";
export const CONTAINER_BUILD_CHOICES: Choice<ContainerBuild>[] = [
  { value: "Container", label: "CodeBuild", description: "build in AWS using CodeBuild" },
  {
    value: "Container-local",
    label: "Local",
    description:
      "build on this machine or CI runner, then publish through CDK; requires Linux ARM64 support",
  },
];

export function ContainerBuildField({
  value,
  onChange,
}: {
  value: ContainerBuild;
  onChange: (value: ContainerBuild) => void;
}) {
  return <ChoiceField choices={CONTAINER_BUILD_CHOICES} value={value} onChange={onChange} />;
}
