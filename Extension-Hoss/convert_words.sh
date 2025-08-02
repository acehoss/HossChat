#!/bin/bash

# Check if input file is provided
if [ $# -ne 1 ]; then
    echo "Usage: $0 input_file"
    exit 1
fi

# Create the JS file with the same name but .js extension
output_file="${1%.*}.js"

# Generate the JS file content
echo "export const words = [" > "$output_file"
sed -e 's/^/  "/' -e 's/$/",/' "$1" >> "$output_file"
# Remove the trailing comma from the last item
sed -i '$ s/,$//' "$output_file"
echo "];" >> "$output_file"

echo "Created $output_file"
