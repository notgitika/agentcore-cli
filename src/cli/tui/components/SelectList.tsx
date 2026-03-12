import { Box, Text } from 'ink';

export interface SelectableItem {
  id: string;
  title: string;
  description?: string;
  disabled?: boolean;
}

export function SelectList<T extends SelectableItem>(props: {
  items: T[];
  selectedIndex: number;
  emptyMessage?: string;
}) {
  if (props.items.length === 0) {
    return (
      <Box flexDirection="column">
        <Text bold>No matches</Text>
        <Text dimColor>{props.emptyMessage ?? 'No items available'}</Text>
        <Text dimColor>Esc to clear search</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {props.items.map((item, idx) => {
        const selected = idx === props.selectedIndex;
        const disabled = item.disabled ?? false;
        return (
          <Box key={item.id}>
            <Text wrap="wrap">
              <Text color={selected && !disabled ? 'cyan' : undefined} dimColor={disabled}>
                {selected ? '❯' : ' '}{' '}
              </Text>
              <Text color={selected && !disabled ? 'cyan' : undefined} dimColor={disabled}>
                {item.title}
              </Text>
              {item.description && <Text dimColor> - {item.description}</Text>}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
